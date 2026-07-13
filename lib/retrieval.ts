import "server-only";
import { CORPUS_VERSION } from "../scripts/ingest/config";
import { serverSupabase } from "./supabase";
import { embedTexts } from "./voyage";

export interface RetrievedChunk {
  id: number;
  law_number: number;
  breadcrumb: string;
  content: string;
  similarity: number;
  rrf_score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  maxSimilarity: number;
}

// Calibrated 2026-07 (Task 3, 30 golden + 10 paraphrase + 6 abstain questions):
// min on-topic maxSimilarity 0.351 vs max off-topic maxSimilarity 0.493 —
// NOT cleanly separable (cricket/NBA/basketball probes overlap the low end of
// real football questions). Deliberately set at the on-topic floor so no real
// football question is ever wrongly gated; a handful of adjacent-sport
// questions may pass through instead, relying on the system prompt's
// "answer football questions only" instruction as the second line of
// defense. Decision: Markus, 2026-07-12.
export const RELEVANCE_THRESHOLD = 0.35;

export function resultFromRows(rows: RetrievedChunk[]): RetrievalResult {
  return {
    chunks: rows,
    maxSimilarity: rows.length ? Math.max(...rows.map((r) => r.similarity)) : 0,
  };
}

export function isRelevant(result: RetrievalResult): boolean {
  return result.maxSimilarity >= RELEVANCE_THRESHOLD;
}

export async function searchChunks(question: string, k = 8): Promise<RetrievalResult> {
  const [embedding] = await embedTexts([question], "query");
  const { data, error } = await serverSupabase().rpc("match_chunks", {
    query_embedding: embedding,
    query_text: question,
    match_count: k,
    version: CORPUS_VERSION,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return resultFromRows((data ?? []) as RetrievedChunk[]);
}
