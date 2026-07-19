import { describe, expect, it } from "vitest";
import {
  isRelevant,
  mergeResults,
  MERGED_CHUNK_CAP,
  RELEVANCE_THRESHOLD,
  resultFromRows,
  type RetrievedChunk,
} from "../lib/retrieval";
import { RELEVANCE_THRESHOLD as CLIENT_RELEVANCE_THRESHOLD } from "../lib/glass-constants";

const row = (similarity: number): RetrievedChunk => ({
  id: 1,
  law_number: 11,
  breadcrumb: "Law 11 › 1. Offside position",
  content: "…",
  similarity,
  rrf_score: 0.03,
});

describe("relevance gate", () => {
  it("computes maxSimilarity across rows", () => {
    expect(resultFromRows([row(0.2), row(0.6)]).maxSimilarity).toBe(0.6);
  });

  it("maxSimilarity is 0 for no rows", () => {
    expect(resultFromRows([]).maxSimilarity).toBe(0);
  });

  it("gates below the threshold", () => {
    expect(isRelevant(resultFromRows([row(RELEVANCE_THRESHOLD - 0.01)]))).toBe(false);
    expect(isRelevant(resultFromRows([row(RELEVANCE_THRESHOLD)]))).toBe(true);
  });

  it("client-side glass-box mirror stays in sync with the server gate", () => {
    // lib/glass-constants.ts hand-duplicates this value because lib/retrieval.ts
    // is server-only and can't be imported from client components. This test
    // is the enforcement that keeps the two from silently drifting apart.
    expect(CLIENT_RELEVANCE_THRESHOLD).toBe(RELEVANCE_THRESHOLD);
  });
});

describe("mergeResults", () => {
  const chunk = (id: number, similarity = 0.5): RetrievedChunk => ({
    id,
    law_number: 3,
    breadcrumb: `Law 3 › ${id}`,
    content: "…",
    similarity,
    rrf_score: 0.03,
  });
  const listOf = (...chunks: RetrievedChunk[]) => resultFromRows(chunks);

  it("round-robins by rank: every list's rank-1 chunk precedes any rank-2 chunk", () => {
    const merged = mergeResults([
      listOf(chunk(1), chunk(2)),
      listOf(chunk(3), chunk(4)),
      listOf(chunk(5)),
    ]);
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 3, 5, 2, 4]);
  });

  it("dedupes by chunk id keeping the best-ranked occurrence", () => {
    const merged = mergeResults([listOf(chunk(1), chunk(2)), listOf(chunk(2), chunk(3))]);
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("caps the merged set at the cap parameter", () => {
    const merged = mergeResults(
      [listOf(chunk(1), chunk(2)), listOf(chunk(3), chunk(4)), listOf(chunk(5), chunk(6))],
      3,
    );
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 3, 5]);
  });

  it("defaults the cap to MERGED_CHUNK_CAP", () => {
    const lists = [0, 1].map((n) =>
      listOf(...Array.from({ length: 8 }, (_, i) => chunk(n * 100 + i))),
    );
    expect(mergeResults(lists).chunks).toHaveLength(MERGED_CHUNK_CAP);
  });

  it("maxSimilarity spans ALL inputs, including chunks dropped by the cap", () => {
    // Gate semantics (spec §5): abstain is decided on everything retrieved,
    // not just what survives the cap.
    const hot = listOf(chunk(9, 0.9));
    const cold = listOf(chunk(1, 0.2), chunk(2, 0.2));
    const merged = mergeResults([cold, hot], 1);
    expect(merged.chunks.map((c) => c.id)).toEqual([1]);
    expect(merged.maxSimilarity).toBe(0.9);
  });

  it("returns an empty result with maxSimilarity 0 for no inputs", () => {
    expect(mergeResults([])).toEqual({ chunks: [], maxSimilarity: 0 });
  });
});
