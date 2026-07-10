import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/session/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/session", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

describe("POST /api/session", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_PASSWORD", "correct-horse");
    vi.stubEnv("SESSION_SECRET", "test-secret-at-least-32-chars-long!!");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sets session and visitor cookies on the right password", async () => {
    const res = await post({ password: "correct-horse" });
    expect(res.status).toBe(204);
    const setCookie = res.headers.getSetCookie().join(";");
    expect(setCookie).toContain("tfo_session=");
    expect(setCookie).toContain("tfo_visitor=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("rejects a wrong password with 401 and no cookies", async () => {
    const res = await post({ password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post({ nope: true });
    expect(res.status).toBe(400);
  });
});
