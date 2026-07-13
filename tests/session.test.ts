import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  passwordMatches,
  SESSION_MAX_AGE_S,
  verifySessionToken,
} from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

describe("session tokens", () => {
  it("round-trips a freshly created token", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(SECRET, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("other-secret-also-32-chars-long!!!!");
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET);
    const [, sig] = token.split(".");
    expect(await verifySessionToken(SECRET, `${Date.now() - 9999}.${sig}`)).toBe(false);
  });

  it("rejects undefined, empty, and malformed tokens", async () => {
    expect(await verifySessionToken(SECRET, undefined)).toBe(false);
    expect(await verifySessionToken(SECRET, "")).toBe(false);
    expect(await verifySessionToken(SECRET, "no-dot-here")).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issued = Date.now() - (SESSION_MAX_AGE_S * 1000 + 1);
    const token = await createSessionToken(SECRET, issued);
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects a token issued in the future", async () => {
    const token = await createSessionToken(SECRET, Date.now() + 10 * 60_000);
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("accepts the correct password", async () => {
    expect(await passwordMatches(SECRET, "hunter2", "hunter2")).toBe(true);
  });

  it("rejects a wrong password, including different lengths", async () => {
    expect(await passwordMatches(SECRET, "hunter", "hunter2")).toBe(false);
    expect(await passwordMatches(SECRET, "HUNTER2", "hunter2")).toBe(false);
  });
});

describe("domain separation", () => {
  it("rejects a token whose signature was computed without the session prefix", async () => {
    // Simulate a pre-prefix (Part 2a) token: payload signed as raw string.
    // We can't call the private hmac() directly, so recreate it inline.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = String(Date.now());
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
    let bin = "";
    for (const byte of sig) bin += String.fromCharCode(byte);
    const legacySig = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifySessionToken(SECRET, `${payload}.${legacySig}`)).toBe(false);
  });
});
