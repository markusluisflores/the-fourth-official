import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy module-level singleton — one client per server process instead of one
// per request (PR #1 review note). Server code only; Task 8 adds the
// server-only guard alongside retrieval's.
let client: SupabaseClient | null = null;

export function serverSupabase(): SupabaseClient {
  client ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return client;
}
