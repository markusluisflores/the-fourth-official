import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const VISITOR_DAILY_LIMIT = 20;
export const GLOBAL_DAILY_LIMIT = 500;

// Spec §8: keyed on IP + cookie. Hashed so raw IPs never land in the database.
export function visitorKey(ip: string, visitorId: string): string {
  return createHash("sha256").update(`${ip}:${visitorId}`).digest("hex").slice(0, 32);
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
