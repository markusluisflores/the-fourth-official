import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

const ask = (cookie?: string) => {
  const req = new NextRequest("http://localhost/api/ask", { method: "POST" });
  if (cookie) req.cookies.set(SESSION_COOKIE, cookie);
  return middleware(req);
};

describe("middleware", () => {
  beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("passes through with a valid session cookie", async () => {
    const res = await ask(await createSessionToken(SECRET));
    expect(res.status).toBe(200); // NextResponse.next() reports 200
  });

  it("rejects a missing session cookie with 401", async () => {
    const res = await ask();
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with 401", async () => {
    const res = await ask("12345.not-a-real-signature");
    expect(res.status).toBe(401);
  });
});
