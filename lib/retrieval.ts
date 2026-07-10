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

export const RELEVANCE_THRESHOLD = 0.35; // starting point — tuned against evals (Task 8)

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
