import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const config = { matcher: ["/api/ask"] };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const ok = await verifySessionToken(
    requireEnv("SESSION_SECRET"),
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}
