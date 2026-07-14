import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  VISITOR_COOKIE,
} from "@/lib/session";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  console.log("xff-probe", { xff: req.headers.get("x-forwarded-for") });
  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Known gap, flagged in Part 2a's security review (2026-07-12), left for
  // a design-review decision rather than fixed here: no rate limit or
  // lockout on password attempts. Context for that decision — a
  // brute-forced session grants nothing beyond what any legitimate visitor
  // already has, since the global daily ceiling in /api/ask (not this
  // gate) is the app's real spend boundary, so the worst case is griefing
  // the shared budget rather than a security breach. Whether that's an
  // acceptable trade-off for a fair-use gate, or worth a proper per-IP
  // attempt limit (new migration/RPC), is an open call — see
  // NEXT-SESSION.md.
  const secret = requireEnv("SESSION_SECRET");
  if (!(await passwordMatches(secret, password, requireEnv("DEMO_PASSWORD")))) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  const res = new NextResponse(null, { status: 204 });
  const cookieOpts = { httpOnly: true, sameSite: "lax", secure: true, path: "/" } as const;
  res.cookies.set(SESSION_COOKIE, await createSessionToken(secret), {
    ...cookieOpts,
    maxAge: SESSION_MAX_AGE_S,
  });
  // Visitor ID feeds the per-visitor rate limit key. Set at login (not in
  // middleware) so /api/ask always sees it on the request, even the first one.
  if (!req.cookies.get(VISITOR_COOKIE)) {
    res.cookies.set(VISITOR_COOKIE, crypto.randomUUID(), {
      ...cookieOpts,
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
