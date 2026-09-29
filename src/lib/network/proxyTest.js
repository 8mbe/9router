import net from "node:net";
import tls from "node:tls";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// A neutral connectivity-check endpoint. google.com is refused outright by some
// proxy networks (Bright Data datacenter/ISP zones: policy_20110), which made
// working proxies look dead.
const DEFAULT_TEST_URL = "https://cp.cloudflare.com/generate_204";
const DEFAULT_TIMEOUT_MS = 8000;
const TUNNEL_REFUSED_RE = /Proxy response \((\d+)\)/;
// Headers proxies use to say why they refused a CONNECT.
const PROXY_REASON_HEADERS = ["x-brd-err-msg", "x-brd-error", "proxy-status", "x-squid-error"];

// undici wraps a refused CONNECT as fetch failed -> "Request was cancelled." ->
// "Proxy response (403) !== 200 ...", so walk the whole cause chain.
function findTunnelStatus(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    const match = TUNNEL_REFUSED_RE.exec(e?.message || "");
    if (match) return Number(match[1]);
  }
  return null;
}

// undici drops the CONNECT response headers, so repeat the CONNECT by hand to
// read the proxy's own explanation. Returns null when nothing useful comes back.
function probeTunnelRefusal(proxyUrl, targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    let proxy;
    let target;
    try {
      proxy = new URL(proxyUrl);
      target = new URL(targetUrl);
    } catch {
      resolve(null);
      return;
    }

    const secure = proxy.protocol === "https:";
    const port = Number(proxy.port) || (secure ? 443 : 80);
    const targetHost = `${target.hostname}:${target.port || (target.protocol === "http:" ? 80 : 443)}`;
    const lines = [`CONNECT ${targetHost} HTTP/1.1`, `Host: ${targetHost}`];
    if (proxy.username) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      lines.push(`Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}`);
    }

    const socket = secure
      ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port });
    let buffer = "";
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("error", () => finish(null));
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1 && buffer.length < 16384) return;

      const [statusLine, ...headerLines] = buffer.slice(0, end === -1 ? undefined : end).split("\r\n");
      const headers = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const reason = PROXY_REASON_HEADERS.map((name) => headers[name]).find(Boolean);
      finish({ statusLine: statusLine.trim(), reason: reason || null });
    });
  });
}

export function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      // GET, not HEAD: some endpoints stall on HEAD through a tunnel.
      const res = await undiciFetch(normalizedTestUrl, {
        method: "GET",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "9Router",
        },
      });

      await res.body?.cancel().catch(() => {});

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (err?.name === "AbortError") {
        return { ok: false, status: 500, error: "Proxy test timed out" };
      }

      const tunnelStatus = findTunnelStatus(err);
      if (tunnelStatus) {
        const probe = await probeTunnelRefusal(normalizedProxyUrl, normalizedTestUrl, 5000);
        const refusal = probe?.statusLine || `HTTP ${tunnelStatus}`;
        const detail = probe?.reason ? `: ${probe.reason}` : "";
        // 502, not the proxy's own code: callers echo `status` as their HTTP
        // status, and browsers reject a 407 that doesn't come from a proxy.
        return {
          ok: false,
          status: 502,
          proxyStatus: tunnelStatus,
          error: `Proxy refused the tunnel to ${new URL(normalizedTestUrl).host} (${refusal})${detail}`,
        };
      }

      return { ok: false, status: 500, error: getErrorMessage(err) };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
