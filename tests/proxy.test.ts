import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

const request = (path: string, cookie?: string) => {
  const req = new NextRequest(`http://localhost${path}`, {
    method: path === "/api/ask" ? "POST" : "GET",
  });
  if (cookie) req.cookies.set(SESSION_COOKIE, cookie);
  return proxy(req);
};

describe("proxy", () => {
  beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("passes through /api/ask with a valid session cookie", async () => {
    const res = await request("/api/ask", await createSessionToken(SECRET));
    expect(res.status).toBe(200); // NextResponse.next() reports 200
  });

  it("rejects /api/ask without a session as 401 JSON", async () => {
    const res = await request("/api/ask");
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with 401", async () => {
    const res = await request("/api/ask", "12345.not-a-real-signature");
    expect(res.status).toBe(401);
  });

  it("passes through / with a valid session", async () => {
    const res = await request("/", await createSessionToken(SECRET));
    expect(res.status).toBe(200);
  });

  it("redirects / without a session to /gate", async () => {
    const res = await request("/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/gate");
  });

  it("fails closed on /api/ask when SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    await expect(request("/api/ask")).rejects.toThrow("SESSION_SECRET is not set");
  });
});
