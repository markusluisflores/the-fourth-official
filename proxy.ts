import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Next.js 16 proxy convention (formerly middleware.ts). Gates the paid API
// route (401 JSON) and the ask page (redirect to the gate screen).
export const config = { matcher: ["/", "/api/ask"] };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const ok = await verifySessionToken(
    requireEnv("SESSION_SECRET"),
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname === "/api/ask") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/gate", req.url));
}
