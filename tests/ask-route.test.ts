import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AnswerEvent } from "../lib/answer";
import { createSessionToken, SESSION_COOKIE, VISITOR_COOKIE } from "../lib/session";
import { DECOMPOSE_SOFT_DEADLINE_MS } from "../lib/decompose";

// Mock every server dependency before importing the route.
const searchChunks = vi.fn();
const searchChunksBatch = vi.fn();
const decompose = vi.fn();
const verifySessionToken = vi.fn();
const recordQuestion = vi.fn();
const streamAnswer = vi.fn();
vi.mock("../lib/retrieval", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchChunks: (...args: unknown[]) => searchChunks(...args),
  searchChunksBatch: (...args: unknown[]) => searchChunksBatch(...args),
}));
vi.mock("../lib/decompose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/decompose")>();
  return {
    ...actual,
    decompose: (...args: unknown[]) => decompose(...args),
  };
});
vi.mock("../lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session")>();
  return {
    ...actual,
    verifySessionToken: (...args: unknown[]) => verifySessionToken(...args),
  };
});
vi.mock("../lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordQuestion: (...args: unknown[]) => recordQuestion(...args),
}));
vi.mock("../lib/answer", () => ({
  streamAnswer: (...args: unknown[]) => streamAnswer(...args),
}));
vi.mock("../lib/supabase", () => ({ serverSupabase: () => ({}) }));

import { POST } from "../app/api/ask/route";
import { RELEVANCE_THRESHOLD } from "../lib/retrieval";

const SECRET = "test-secret-at-least-32-chars-long!!";

const chunkRow = {
  id: 1,
  law_number: 11,
  breadcrumb: "Law 11 › 1. Offside position",
  content: "…",
  similarity: RELEVANCE_THRESHOLD + 0.2,
  rrf_score: 0.03,
};

async function post(body: unknown, withSession = true) {
  const req = new NextRequest("http://localhost/api/ask", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (withSession) req.cookies.set(SESSION_COOKIE, await createSessionToken(SECRET));
  req.cookies.set(VISITOR_COOKIE, "vis-1");
  return POST(req);
}

// Builds the request (including the real, cryptographically-signed session
// cookie) eagerly, so it can be constructed BEFORE fake timers are enabled
// in the soft-deadline tests below.
async function buildRequest(body: unknown) {
  const req = new NextRequest("http://localhost/api/ask", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  req.cookies.set(SESSION_COOKIE, await createSessionToken(SECRET));
  req.cookies.set(VISITOR_COOKIE, "vis-1");
  return req;
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  recordQuestion.mockResolvedValue({ visitorCount: 1, globalCount: 1 });
  searchChunks.mockResolvedValue({
    chunks: [chunkRow],
    maxSimilarity: chunkRow.similarity,
  });
  decompose.mockResolvedValue(null);
  const actualSession = await vi.importActual<typeof import("../lib/session")>("../lib/session");
  verifySessionToken.mockImplementation(actualSession.verifySessionToken);
  async function* fake(): AsyncGenerator<AnswerEvent> {
    yield { type: "text", delta: "Answer." };
    yield { type: "done", citedDocumentIndexes: [0], stopReason: "end_turn" };
  }
  streamAnswer.mockImplementation(() => fake());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/ask", () => {
  it("rejects a missing session with 401 even if middleware were bypassed", async () => {
    expect((await post({ question: "offside?" }, false)).status).toBe(401);
  });

  it("rejects a missing or over-length question with 400", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ question: "x".repeat(301) })).status).toBe(400);
    expect(recordQuestion).not.toHaveBeenCalled();
  });

  it("returns 429 with scope visitor when the visitor limit is exceeded", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 21, globalCount: 50 });
    const res = await post({ question: "offside?" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ kind: "rate_limited", scope: "visitor" });
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it("returns 429 with scope global when the daily ceiling is hit", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 2, globalCount: 501 });
    const res = await post({ question: "offside?" });
    expect(await res.json()).toMatchObject({ kind: "rate_limited", scope: "global" });
  });

  it("returns the gated JSON response without calling Claude when below threshold", async () => {
    searchChunks.mockResolvedValue({
      chunks: [chunkRow],
      maxSimilarity: RELEVANCE_THRESHOLD - 0.05,
    });
    const res = await post({ question: "lbw in cricket?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ kind: "gated" });
    expect(streamAnswer).not.toHaveBeenCalled();
  });

  it("streams meta, text, and done as SSE on the happy path", async () => {
    const res = await post({ question: "when is a player offside?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: meta");
    expect(body).toContain('"remaining":{"visitor":19}');
    expect(body).toContain("event: text");
    expect(body).toContain('"delta":"Answer."');
    expect(body).toContain("event: done");
  });

  it("returns 502 with an honest message when retrieval fails before streaming", async () => {
    searchChunks.mockRejectedValue(new Error("voyage exploded"));
    const res = await post({ question: "offside?" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("try again") });
  });

  it("returns 502 with an honest message when the rate-limit counter fails", async () => {
    recordQuestion.mockRejectedValue(new Error("db down"));
    const res = await post({ question: "offside?" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("try again") });
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it("emits an SSE error event and still closes the stream when generation throws mid-stream", async () => {
    async function* dying(): AsyncGenerator<AnswerEvent> {
      yield { type: "text", delta: "partial" };
      throw new Error("boom");
    }
    streamAnswer.mockImplementation(() => dying());
    const res = await post({ question: "when is a player offside?" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: text");
    expect(body).toContain('"delta":"partial"');
    expect(body).toContain("event: error");
    expect(body).toContain('"message":"something went wrong, please try again shortly"');
  });

  it("stops consuming the generator when the client disconnects", async () => {
    // `generatorFinallyRan` alone can't distinguish correct cancel() wiring
    // from a no-op one: Node's ReadableStream unconditionally closes the
    // controller as soon as reader.cancel() is called, *before* it ever
    // invokes our custom cancel() handler. So even with cancel() disabled,
    // the very next controller.enqueue() throws, and the throw's abrupt
    // completion of the `for await` loop implicitly calls gen.return() via
    // the iterator-close protocol - the generator's finally still runs
    // either way, just via a different path. What differs is *how* it gets
    // there: a working cancel() flags `cancelled` so the loop breaks before
    // attempting to enqueue, producing no error; a broken one lets the
    // enqueue throw, which the route's catch block reports as a genuine
    // mid-stream failure ("generation failed mid-stream") even though the
    // client just navigated away. That misreported error is the signal this
    // test asserts on - it flips only when the fix's cancelled-flag/break
    // wiring is actually in place.
    //
    // The real per-yield delay keeps the generator legitimately in flight
    // (mid an internal await) at cancel time, so the assertion can't be
    // satisfied by the mock racing to natural completion before cancel()
    // even runs (the original defect this test is closing).
    const YIELD_DELAY_MS = 100;
    const POST_CANCEL_WAIT_MS = 150;
    let generatorFinallyRan = false;
    async function* slow(): AsyncGenerator<AnswerEvent> {
      try {
        yield { type: "text", delta: "a" };
        await new Promise((r) => setTimeout(r, YIELD_DELAY_MS));
        yield { type: "text", delta: "b" };
        await new Promise((r) => setTimeout(r, YIELD_DELAY_MS));
        yield { type: "text", delta: "c" };
      } finally {
        generatorFinallyRan = true;
      }
    }
    streamAnswer.mockImplementation(() => slow());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ question: "when is a player offside?" });
    const reader = res.body!.getReader();
    await reader.read(); // meta
    await reader.cancel();
    await new Promise((r) => setTimeout(r, POST_CANCEL_WAIT_MS));
    expect(generatorFinallyRan).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  const chunkRow2 = { ...chunkRow, id: 2, breadcrumb: "Law 10 › 2. Winning team" };

  it("keeps the simple path when decompose returns one sub-question or null", async () => {
    decompose.mockResolvedValue(["when is a player offside?"]);
    const res = await post({ question: "when is a player offside?" });
    expect(res.status).toBe(200);
    expect(searchChunksBatch).not.toHaveBeenCalled();
  });

  it("merges sub-question retrievals and answers with the ORIGINAL question", async () => {
    decompose.mockResolvedValue(["what abandons a match?", "is there a shoot-out?"]);
    searchChunksBatch.mockResolvedValue([
      { chunks: [chunkRow2], maxSimilarity: chunkRow2.similarity },
    ]);
    const res = await post({ question: "what happens if everyone is sent off?" });
    const body = await res.text();
    expect(searchChunksBatch).toHaveBeenCalledWith(
      ["what abandons a match?", "is there a shoot-out?"],
      8,
    );
    // meta carries the merged set (both chunk ids)
    expect(body).toContain('"id":1');
    expect(body).toContain('"id":2');
    // spec §3: the answering model sees the visitor's original question only
    expect(streamAnswer).toHaveBeenCalledWith(
      "what happens if everyone is sent off?",
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ]),
    );
  });

  it("falls back to the baseline result when sub-question retrieval throws", async () => {
    decompose.mockResolvedValue(["a?", "b?"]);
    searchChunksBatch.mockRejectedValue(new Error("Voyage API 429"));
    const res = await post({ question: "compound?" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: text"); // still streams from baseline chunks
    expect(streamAnswer).toHaveBeenCalledWith("compound?", [chunkRow]);
  });

  it("gates on the MERGED max similarity", async () => {
    // Baseline is sub-threshold; a sub-question result clears it — merged
    // max decides (spec §5), so this streams instead of gating.
    searchChunks.mockResolvedValue({
      chunks: [{ ...chunkRow, similarity: RELEVANCE_THRESHOLD - 0.05 }],
      maxSimilarity: RELEVANCE_THRESHOLD - 0.05,
    });
    decompose.mockResolvedValue(["a?", "b?"]);
    searchChunksBatch.mockResolvedValue([
      { chunks: [chunkRow2], maxSimilarity: RELEVANCE_THRESHOLD + 0.1 },
    ]);
    const res = await post({ question: "compound?" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("never calls decompose for rate-limited questions (paid call after count)", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 21, globalCount: 50 });
    await post({ question: "offside?" });
    expect(decompose).not.toHaveBeenCalled();
  });

  it("treats a slow decompose as simple once the soft deadline elapses (spec §3, §6)", async () => {
    // Build the request (real WebCrypto session-token signing) BEFORE
    // enabling fake timers, and mock verifySessionToken (also real
    // WebCrypto — see route.ts's first line) so nothing in this test needs
    // a genuine event-loop turn to resolve once fake timers are active.
    // Fable's design review on PR #50 found this by actually running the
    // test: WebCrypto's async work doesn't advance with vi's fake timers,
    // so a single vi.advanceTimersByTimeAsync() call would sweep before the
    // route ever reached the point of registering the soft-deadline timer,
    // making the test hang/timeout every run.
    const req = await buildRequest({ question: "compound?" });
    verifySessionToken.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      let resolveDecompose: (v: string[] | null) => void = () => {};
      decompose.mockImplementation(
        () =>
          new Promise<string[] | null>((resolve) => {
            resolveDecompose = resolve;
          }),
      );
      const resPromise = POST(req);
      await vi.advanceTimersByTimeAsync(DECOMPOSE_SOFT_DEADLINE_MS + 50);
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(searchChunksBatch).not.toHaveBeenCalled();

      // The late answer arrives after the response was already produced —
      // it must have no further effect (spec §6, "answers after the soft
      // deadline" row).
      resolveDecompose(["a?", "b?"]);
      await vi.runAllTimersAsync();
      expect(searchChunksBatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a decompose answer that already resolved while baseline retrieval was the slow one (spec §3 elapsed-aware deadline)", async () => {
    // If baseline alone already used up the whole soft-deadline budget, an
    // ALREADY-RESOLVED decompose answer must still be used — not discarded
    // by a fixed wall-clock cutoff measured from request start. This is the
    // property Fable's design review specifically asked to be tested.
    // Same buildRequest + verifySessionToken mock as the test above, for
    // the same WebCrypto-vs-fake-timers reason.
    const req = await buildRequest({ question: "what happens if everyone is sent off?" });
    verifySessionToken.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      decompose.mockResolvedValue(["what abandons a match?", "is there a shoot-out?"]);
      searchChunksBatch.mockResolvedValue([
        { chunks: [chunkRow2], maxSimilarity: chunkRow2.similarity },
      ]);
      searchChunks.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ chunks: [chunkRow], maxSimilarity: chunkRow.similarity }),
              DECOMPOSE_SOFT_DEADLINE_MS + 100,
            );
          }),
      );
      const resPromise = POST(req);
      await vi.advanceTimersByTimeAsync(DECOMPOSE_SOFT_DEADLINE_MS + 150);
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(searchChunksBatch).toHaveBeenCalledWith(
        ["what abandons a match?", "is there a shoot-out?"],
        8,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
