import { describe, expect, it } from "vitest";
import {
  isRelevant,
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
