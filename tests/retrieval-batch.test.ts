import { afterEach, describe, expect, it, vi } from "vitest";

const embedTexts = vi.fn();
vi.mock("../lib/voyage", () => ({
  embedTexts: (...args: unknown[]) => embedTexts(...args),
}));
const rpc = vi.fn();
vi.mock("../lib/supabase", () => ({ serverSupabase: () => ({ rpc }) }));

import { searchChunksBatch } from "../lib/retrieval";

const row = (id: number) => ({
  id,
  law_number: 3,
  breadcrumb: `Law 3 › ${id}`,
  content: "…",
  similarity: 0.5,
  rrf_score: 0.03,
});

afterEach(() => vi.clearAllMocks());

describe("searchChunksBatch", () => {
  it("embeds every sub-question in ONE Voyage call, then searches per question", async () => {
    // One call matters: Voyage free tier allows 3 requests/minute (spec §7).
    embedTexts.mockResolvedValue([[0.1], [0.2]]);
    rpc.mockResolvedValue({ data: [row(1)], error: null });
    const results = await searchChunksBatch(["a?", "b?"], 8);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledWith(["a?", "b?"], "query");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "match_chunks",
      expect.objectContaining({ query_text: "a?", match_count: 8 }),
    );
    expect(results).toHaveLength(2);
  });

  it("drops a failed match_chunks call and returns the successes (spec §6)", async () => {
    embedTexts.mockResolvedValue([[0.1], [0.2]]);
    rpc
      .mockResolvedValueOnce({ data: [row(1)], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const results = await searchChunksBatch(["a?", "b?"], 8);
    expect(results).toHaveLength(1);
    expect(results[0].chunks[0].id).toBe(1);
  });

  it("rejects when the embed call itself fails (route falls back to baseline)", async () => {
    embedTexts.mockRejectedValue(new Error("Voyage API 429"));
    await expect(searchChunksBatch(["a?"], 8)).rejects.toThrow("429");
  });
});
