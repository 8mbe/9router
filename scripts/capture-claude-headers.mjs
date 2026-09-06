#!/usr/bin/env node
/**
 * Claude Code header capture proxy.
 *
 * Sits between a real Claude Code CLI and api.anthropic.com, records exactly
 * what the client sends (headers, query string, body shape), and forwards the
 * request upstream untouched so the session still works.
 *
 * Usage:
 *   node scripts/capture-claude-headers.mjs                 # listen on 20199
 *   PORT=9000 node scripts/capture-claude-headers.mjs       # custom port
 *
 * Then, in another shell:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:20199 claude -p "hi"
 *
 * Output:
 *   - human-readable summary on stdout
 *   - full records appended to capture/claude-headers.jsonl
 *   - merged header set (for pasting into a provider registry) at
 *     capture/claude-headers.summary.json
 */
import http from "node:http";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "capture");
const JSONL = resolve(OUT_DIR, "claude-headers.jsonl");
const SUMMARY = resolve(OUT_DIR, "claude-headers.summary.json");

const PORT = Number(process.env.PORT || 20199);
const UPSTREAM = (process.env.UPSTREAM || "https://api.anthropic.com").replace(/\/$/, "");
// Headers whose *value* is a secret. We record presence + shape, never the token.
const SECRET = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);
// Hop-by-hop headers that must not be forwarded.
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

mkdirSync(OUT_DIR, { recursive: true });

// Union of every header name/value seen, so the last write of the summary file
// is a ready-to-copy fingerprint.
const seen = new Map(); // lower-name -> { name, values:Set, secret:boolean, count:number }

function redact(name, value) {
  if (!SECRET.has(name.toLowerCase())) return value;
  const m = /^(\w+)\s+(.*)$/.exec(value);
  if (m) return `${m[1]} <${m[2].length} chars, starts ${m[2].slice(0, 8)}…>`;
  return `<${value.length} chars, starts ${value.slice(0, 8)}…>`;
}

function record(req, rawHeaders, bodyText) {
  const headers = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    const key = name.toLowerCase();
    headers[name] = redact(name, value);
    const entry = seen.get(key) || { name, values: new Set(), secret: SECRET.has(key), count: 0 };
    entry.name = name; // preserve the client's exact casing
    entry.count += 1;
    if (!entry.secret) entry.values.add(value);
    seen.set(key, entry);
  }

  let body = null;
  try {
    const parsed = JSON.parse(bodyText);
    body = {
      model: parsed.model,
      stream: parsed.stream,
      max_tokens: parsed.max_tokens,
      temperature: parsed.temperature,
      top_keys: Object.keys(parsed),
      system_blocks: Array.isArray(parsed.system)
        ? parsed.system.map(b => ({ type: b.type, cache_control: b.cache_control, preview: String(b.text || "").slice(0, 160) }))
        : typeof parsed.system === "string" ? String(parsed.system).slice(0, 160) : undefined,
      metadata: parsed.metadata,
      tool_count: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      tool_names: Array.isArray(parsed.tools) ? parsed.tools.map(t => t.name) : [],
      thinking: parsed.thinking,
      context_management: parsed.context_management,
      message_count: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    };
  } catch {
    body = { unparsed_bytes: Buffer.byteLength(bodyText || "") };
  }

  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    header_order: rawHeaders.filter((_, i) => i % 2 === 0),
    headers,
    body,
  };
  appendFileSync(JSONL, JSON.stringify(rec) + "\n");

  const merged = {};
  const secrets = [];
  for (const [key, e] of [...seen.entries()].sort()) {
    if (e.secret) { secrets.push(e.name); continue; }
    const values = [...e.values];
    merged[e.name] = values.length === 1 ? values[0] : values;
  }
  writeFileSync(SUMMARY, JSON.stringify({
    captured_requests: [...seen.values()].reduce((m, e) => Math.max(m, e.count), 0),
    auth_headers: secrets,
    headers: merged,
  }, null, 2));

  console.log(`\n=== ${rec.method} ${rec.url}  (${rec.at}) ===`);
  const width = Math.max(...rawHeaders.filter((_, i) => i % 2 === 0).map(h => h.length), 0);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    console.log(`  ${rawHeaders[i].padEnd(width)} : ${redact(rawHeaders[i], rawHeaders[i + 1])}`);
  }
  console.log("  body:", JSON.stringify(body, null, 2).split("\n").join("\n  "));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    try {
      record(req, req.rawHeaders, raw.toString("utf8"));
    } catch (err) {
      console.error("capture failed (forwarding anyway):", err.message);
    }

    const outHeaders = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (HOP.has(req.rawHeaders[i].toLowerCase())) continue;
      outHeaders[req.rawHeaders[i]] = req.rawHeaders[i + 1];
    }

    try {
      const upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers: outHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : raw,
        redirect: "manual",
      });
      const resHeaders = {};
      upstream.headers.forEach((v, k) => { if (!HOP.has(k)) resHeaders[k] = v; });
      res.writeHead(upstream.status, resHeaders);
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
      }
      res.end();
    } catch (err) {
      console.error("upstream error:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: String(err) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude header capture proxy → ${UPSTREAM}`);
  console.log(`listening on http://127.0.0.1:${PORT}`);
  console.log(`records  : ${JSONL}`);
  console.log(`summary  : ${SUMMARY}`);
  console.log(`\nrun:  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude -p "hi"\n`);
});
