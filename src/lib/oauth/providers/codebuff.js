import { createHash, randomBytes } from "crypto";
import os from "os";
import { CODEBUFF_CONFIG } from "../constants/oauth.js";

// The CLI's login User-Agent. Every non-chat upstream call the real CLI makes
// goes through a bare Bun fetch with no UA override, so Bun sends its own
// default. 1.3.14 matches the CLI's pinned .bun-version.
const BUN_USER_AGENT = "Bun/1.3.14";

/**
 * Machine fingerprint id, shaped like the CLI's hardware fingerprint:
 * "enhanced-" + base64url(sha256(JSON.stringify(info))) with fingerprintVersion 2.0.
 *
 * 9router is multi-account by design, so the DEFAULT is an isolated (random)
 * fingerprint — the same choice the reference gateway's dashboard wizard makes.
 * Two accounts added from one machine must not share a hardware identifier, or
 * upstream correlates them as one device.
 */
function isolatedFingerprintId() {
  return "enhanced-" + randomBytes(32).toString("base64url");
}

/**
 * Deterministic per-host fingerprint id — the shape the CLI derives from real
 * hardware. Kept for single-account setups that want a stable device identity
 * across re-logins (opt-in via options.stableFingerprint).
 */
function hostFingerprintId() {
  const hostname = os.hostname();
  const macs = Object.values(os.networkInterfaces() || {})
    .flat()
    .filter((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")
    .map((i) => i.mac)
    .sort();
  const ifaceCount = Object.keys(os.networkInterfaces() || {}).length;
  const cpus = os.cpus() || [];
  const seedHex = createHash("sha256").update(`${hostname}|${macs.join(",")}`).digest("hex");
  const platform = os.platform() === "win32" ? "win32" : os.platform();
  const arch = os.arch() === "x64" ? "x64" : os.arch();
  const info = {
    system: {
      manufacturer: "",
      model: "",
      serial: seedHex.slice(0, 16),
      uuid: `${seedHex.slice(16, 24)}-${seedHex.slice(24, 28)}-${seedHex.slice(28, 32)}-${seedHex.slice(32, 36)}-${seedHex.slice(36, 52)}`,
    },
    cpu: {
      manufacturer: "GenuineIntel",
      brand: cpus[0]?.model?.trim() || "Generic CPU",
      cores: cpus.length,
      physicalCores: cpus.length,
    },
    os: {
      platform,
      distro: platform === "darwin" ? "Apple macOS" : platform === "linux" ? "Ubuntu Linux" : "Microsoft Windows 11 Pro",
      arch,
      hostname,
    },
    runtime: {
      nodeVersion: process.version,
      platform,
      arch,
      shell: "/bin/bash",
      cpuCount: cpus.length,
    },
    network: { macAddresses: macs, interfaceCount: ifaceCount },
    machineId: seedHex.slice(0, 32),
    fingerprintVersion: "2.0",
  };
  return "enhanced-" + createHash("sha256").update(JSON.stringify(info)).digest("base64url");
}

const codebuff = {
  config: CODEBUFF_CONFIG,
  flowType: "device_code",

  /**
   * POST /api/auth/cli/code → { fingerprintId, fingerprintHash, loginUrl, expiresAt }.
   *
   * Mapped onto the generic device-code contract: the fingerprintId plays the
   * role of device_code, loginUrl the role of verification_uri_complete. The
   * hash and the VERBATIM expiresAt must both ride along to the status poll —
   * expiresAt is epoch MILLISECONDS and the status backend compares it against
   * Date.now(), so re-encoding it as seconds silently breaks the poll.
   */
  requestDeviceCode: async (config, _codeChallenge, options = {}) => {
    const fingerprintId = options.stableFingerprint ? hostFingerprintId() : isolatedFingerprintId();
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BUN_USER_AGENT,
      },
      body: JSON.stringify({ fingerprintId }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Codebuff login start failed (${response.status}): ${text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Codebuff login start returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!data.fingerprintHash || !data.loginUrl) {
      throw new Error("Codebuff login start response missing fingerprintHash/loginUrl");
    }

    const expiresAtRaw = Number(data.expiresAt) > 0 ? Number(data.expiresAt) : Date.now() + 3600_000;
    // Upstream tolerates both epochs; normalize to seconds only for the UI countdown.
    const expiresMs = expiresAtRaw > 1_000_000_000_000 ? expiresAtRaw : expiresAtRaw * 1000;

    return {
      device_code: data.fingerprintId || fingerprintId,
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      interval: 5,
      expires_in: Math.max(60, Math.floor((expiresMs - Date.now()) / 1000)),
      _cbFingerprintHash: data.fingerprintHash,
      _cbExpiresAt: String(expiresAtRaw),
    };
  },

  /**
   * GET /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt.
   *
   * 401 is the unclaimed-code state, not a failure: the real CLI polls straight
   * through 401s and 5xx until its own deadline. Both map to
   * authorization_pending so the generic poller keeps going.
   */
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const url = new URL(config.tokenUrl);
    url.searchParams.set("fingerprintId", deviceCode);
    url.searchParams.set("fingerprintHash", extraData?._cbFingerprintHash || "");
    url.searchParams.set("expiresAt", extraData?._cbExpiresAt || "");

    let response;
    try {
      response = await fetch(url.toString(), {
        headers: { "User-Agent": BUN_USER_AGENT },
      });
    } catch (e) {
      // Transport blip — keep polling rather than failing the whole login.
      return { ok: true, data: { error: "authorization_pending", error_description: e.message } };
    }

    if (response.status === 401 || response.status >= 500) {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, data: { error: "login_failed", error_description: text.slice(0, 200) } };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: true, data: { error: "authorization_pending" } };
    }

    const token = (data.authToken || data.user?.authToken || "").trim();
    if (!token) {
      return { ok: true, data: { error: "authorization_pending" } };
    }

    return {
      ok: true,
      data: {
        access_token: token,
        _cbUser: data.user || {},
        _cbFingerprintId: deviceCode,
      },
    };
  },

  /**
   * The status payload already carries the account, but it can be thin. A
   * GET /api/v1/me fills in the email the connection list shows — and is the
   * same call the CLI makes right after login, so it costs nothing in parity.
   */
  postExchange: async (tokens) => {
    let me = {};
    try {
      const res = await fetch(CODEBUFF_CONFIG.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": BUN_USER_AGENT,
        },
      });
      if (res.ok) me = await res.json();
    } catch {
      // Non-fatal: the token is already valid, the label is cosmetic.
    }
    return { me, user: tokens._cbUser || {} };
  },

  mapTokens: (tokens, extra) => {
    const user = extra?.user || {};
    const me = extra?.me || {};
    const accountId = me.id || me.user?.id || user.id || null;
    const email = me.email || me.user?.email || user.email || null;
    return {
      accessToken: tokens.access_token,
      // Upstream issues no refresh token: the CLI token is long-lived and a
      // 401 means re-login, never a silent rotation.
      refreshToken: null,
      expiresIn: null,
      name: user.name || me.name || email,
      displayName: user.name || me.name || email,
      email,
      providerSpecificData: {
        codebuffUserId: accountId,
        codebuffEmail: email,
        // The fingerprint this token was minted under. Reused for the
        // account's session calls so one account keeps one device identity.
        fingerprintId: tokens._cbFingerprintId || null,
      },
    };
  },
};

export default codebuff;
