import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "../lib/voyage";

function mockVoyageResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: async () => ({ data: embeddings.map((e, i) => ({ index: i, embedding: e })) }),
  } as Response;
}

describe("embedTexts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns embeddings in input order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockVoyageResponse([
          [1, 2],
          [3, 4],
        ]),
      ),
    );
    const result = await embedTexts(["a", "b"], "document");
    expect(result).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns [] for empty input without calling the API", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await embedTexts([], "query")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws with status detail on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" } as Response),
    );
    await expect(embedTexts(["a"], "query")).rejects.toThrow(/401/);
  });
});
