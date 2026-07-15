import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AnswerEvent } from "../lib/answer";
import { createSessionToken, SESSION_COOKIE, VISITOR_COOKIE } from "../lib/session";

// Mock every server dependency before importing the route.
const searchChunks = vi.fn();
const recordQuestion = vi.fn();
const streamAnswer = vi.fn();
vi.mock("../lib/retrieval", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchChunks: (...args: unknown[]) => searchChunks(...args),
}));
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

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  recordQuestion.mockResolvedValue({ visitorCount: 1, globalCount: 1 });
  searchChunks.mockResolvedValue({
    chunks: [chunkRow],
    maxSimilarity: chunkRow.similarity,
  });
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
});
