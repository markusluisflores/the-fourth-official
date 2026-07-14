import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const VISITOR_DAILY_LIMIT = 20;
export const GLOBAL_DAILY_LIMIT = 500;

// Spec §8: keyed on IP + cookie. Hashed so raw IPs never land in the database.
// Security review note (Part 2b Task 11): the cookie half of this key is
// still trivially resettable — any client can clear cookies before their
// next login and get a fresh VISITOR_COOKIE (app/api/session/route.ts only
// sets it when absent). trustedClientIp closes the IP half, but the 20/day
// per-visitor cap remains a fairness speed bump, not a hard identity
// boundary. Bounded regardless by GLOBAL_DAILY_LIMIT, which record_question
// gates per-request on each visitor's own cap check.
export function visitorKey(ip: string, visitorId: string): string {
  return createHash("sha256").update(`${ip}:${visitorId}`).digest("hex").slice(0, 32);
}

// Which x-forwarded-for hop to trust is platform-specific. Verified live on
// Railway (Part 2b Task 10 probe, 2026-07): the edge OVERWRITES whatever
// x-forwarded-for the client sends — four requests with different/absent
// client-supplied values all produced the real client IP as the leftmost
// entry (confirmed against the probing machine's independently-verified
// public IP), with a second, Railway-internal hop IP appended after (not
// stable across requests, not client-influenced). This is the OPPOSITE of
// the commonly-assumed "trust the rightmost, client-appended" pattern this
// project's earlier review (PR #16) flagged as a risk — on Railway, the
// client cannot inject anything into this header at all, so there is no
// spoofing vector to defend against here; the fix is purely about
// extracting the real IP correctly.
// Caveat (security review, Part 2b Task 11): this evidence is empirical,
// from one network, against Railway's *current* edge behavior — not
// confirmed against Railway's own docs, and there's no code-level signal if
// Railway's proxy topology ever changes (e.g. a CDN/WAF added in front).
// If IP-based rate limiting ever looks like it's misbehaving, re-run the
// live probe (see NEXT-SESSION.md) before assuming this logic is still
// correct.
export function trustedClientIp(header: string | null): string {
  const first = header?.split(",")[0]?.trim();
  return first || "local";
}

export interface UsageCounts {
  visitorCount: number;
  globalCount: number;
}

export async function recordQuestion(supabase: SupabaseClient, key: string): Promise<UsageCounts> {
  const { data, error } = await supabase.rpc("record_question", {
    visitor_key: key,
    visitor_limit: VISITOR_DAILY_LIMIT,
  });
  if (error) throw new Error(`record_question failed: ${error.message}`);
  const row = (data as { visitor_count: number; global_count: number }[])[0];
  if (!row) throw new Error("record_question returned no rows");
  return { visitorCount: row.visitor_count, globalCount: row.global_count };
}
