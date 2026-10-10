import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Loopback bearer token (not user auth): an unauthenticated localhost API that
 * launches agent sessions is a DNS-rebinding/CSRF target. Generated once,
 * persisted, injected into the served SPA, required on every call.
 */
export function loadOrCreateToken(tokenPath: string): string {
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to create
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}
