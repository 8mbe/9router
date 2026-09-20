// Cline's ON-DISK session — the login `cline auth` writes, shared by every
// 9router path that talks to Cline without a stored credential of its own
// (cline-free: the provider has no wire auth, see providers/registry/cline-free.js).
//
// Kept out of executors/cline-free.js so the model-list services can read the
// token without dragging the executor (and @cline/core) into the import graph.

import path from "node:path";
import os from "node:os";
import fsPromises from "node:fs/promises";

// Cline's state directory. Overridable so 9router can run against a non-default
// home (containers, service accounts, a second Cline profile).
export function clineHome() {
  return process.env.CLINE_HOME?.trim() || path.join(os.homedir(), ".cline");
}

// Where `cline auth` persists the OAuth session.
export function clineRealSettingsPath() {
  return path.join(clineHome(), "data", "settings", "providers.json");
}

// 9router drives Cline from its own isolated data dir so a concurrent interactive
// `cline` session cannot fight us over SDK state — but the dir is seeded with the
// real providers.json, or the SDK cannot resolve the logged-in token and silently
// falls back to credit billing.
//
// DATA_DIR wins when set: in Docker that is the mounted volume, and anything written
// under the container's home is lost on `docker rm`.
export function clineAuthDir() {
  const dataDir = process.env.DATA_DIR?.trim();
  return dataDir ? path.join(dataDir, "cline-9router") : path.join(clineHome(), "9router-data");
}

/**
 * Read the OAuth access token out of the local `cline auth` session.
 * Returns "" when Cline is not logged in — callers treat that as "no live
 * catalog" and fall back to the static list, never as an error.
 */
export async function readClineLocalToken() {
  let parsed;
  try {
    parsed = JSON.parse(await fsPromises.readFile(clineRealSettingsPath(), "utf8"));
  } catch {
    return "";
  }
  const providers = parsed?.providers;
  if (!providers || typeof providers !== "object") return "";
  // The `cline` entry is the free/cloud login; any other entry is a BYOK
  // provider, which still carries a usable Cline session when it is an OAuth one.
  for (const entry of [providers.cline, ...Object.values(providers)]) {
    const token = entry?.settings?.auth?.accessToken;
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return "";
}
