// Stateless HMAC sessions. Web Crypto only (no Node Buffer/crypto) so the same
// module runs in Edge middleware and in Node route handlers. Secrets are
// parameters, not process.env reads — callers own configuration.
export const SESSION_COOKIE = "tfo_session";
export const VISITOR_COOKIE = "tfo_visitor";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();

// Domain separation (PR #16 review): the same SESSION_SECRET signs both
// session tokens and password comparisons — prefix the message so an HMAC
// from one domain can never be replayed in the other.
const SESSION_DOMAIN = "session:";
const PASSWORD_DOMAIN = "pw:";

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  let bin = "";
  for (const byte of sig) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string compare (both inputs are same-length HMAC outputs in
// every call site, so length is not an information leak here).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const payload = String(now);
  return `${payload}.${await hmac(secret, SESSION_DOMAIN + payload)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmac(secret, SESSION_DOMAIN + payload))) return false;
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  const ageMs = now - issuedAt;
  const clockSkewMs = 60_000;
  return ageMs < SESSION_MAX_AGE_S * 1000 && ageMs > -clockSkewMs;
}

// HMAC both sides, then constant-time compare — neither timing nor length of
// the real password leaks to the caller.
export async function passwordMatches(
  secret: string,
  submitted: string,
  actual: string,
): Promise<boolean> {
  return timingSafeEqual(
    await hmac(secret, PASSWORD_DOMAIN + submitted),
    await hmac(secret, PASSWORD_DOMAIN + actual),
  );
}
