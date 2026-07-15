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

async function matchChunks(
  embedding: number[],
  questionText: string,
  k: number,
): Promise<RetrievalResult> {
  const { data, error } = await serverSupabase().rpc("match_chunks", {
    query_embedding: embedding,
    query_text: questionText,
    match_count: k,
    version: CORPUS_VERSION,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return resultFromRows((data ?? []) as RetrievedChunk[]);
}

export async function searchChunks(question: string, k = 8): Promise<RetrievalResult> {
  const [embedding] = await embedTexts([question], "query");
  return matchChunks(embedding, question, k);
}

// Merged-set size for compound questions (spec §5) — a bounded generation-cost
// increase over the per-query k=8, paid only on compound questions.
export const MERGED_CHUNK_CAP = 12;

// One Voyage call for all sub-questions (free tier: 3 requests/minute), then
// parallel match_chunks. Per-question failures are dropped, not fatal — the
// route merges whatever succeeded (spec §6). Rejects only if the embed fails.
export async function searchChunksBatch(questions: string[], k = 8): Promise<RetrievalResult[]> {
  const embeddings = await embedTexts(questions, "query");
  const settled = await Promise.allSettled(
    embeddings.map((embedding, i) => matchChunks(embedding, questions[i], k)),
  );
  const successes: RetrievalResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") successes.push(s.value);
    else console.error("sub-question search failed", { question: questions[i].slice(0, 80) });
  });
  return successes;
}

// Rank round-robin: every list's rank-1 chunk beats any list's rank-2 chunk,
// so each sub-question's best evidence survives the cap. Dedupe keeps the
// first (best-ranked) occurrence. maxSimilarity spans ALL inputs — the gate
// decides abstain on everything retrieved, not just what survived the cap.
export function mergeResults(results: RetrievalResult[], cap = MERGED_CHUNK_CAP): RetrievalResult {
  const merged: RetrievedChunk[] = [];
  const seen = new Set<number>();
  const maxLen = results.reduce((m, r) => Math.max(m, r.chunks.length), 0);
  outer: for (let rank = 0; rank < maxLen; rank++) {
    for (const r of results) {
      const c = r.chunks[rank];
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
      if (merged.length >= cap) break outer;
    }
  }
  return {
    chunks: merged,
    maxSimilarity: results.reduce((m, r) => Math.max(m, r.maxSimilarity), 0),
  };
}
