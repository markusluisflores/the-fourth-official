import { describe, expect, it } from "vitest";
import {
  askReducer,
  historyEntryMessage,
  initialAskState,
  REFUSED_MESSAGE,
  type AskState,
  type GlassChunk,
} from "../lib/ask-stream";

const chunk = (id: number, breadcrumb: string): GlassChunk => ({
  id,
  law_number: 15,
  breadcrumb,
  content: `content of ${breadcrumb}`,
  similarity: 0.8,
  rrf_score: 0.03,
});

const run = (actions: Parameters<typeof askReducer>[1][]): AskState =>
  actions.reduce(askReducer, initialAskState);

describe("askReducer", () => {
  it("moves idle → submitting → streaming on submit + meta", () => {
    const s = run([
      { type: "submit", question: "throw-in goal?" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1")], remaining: { visitor: 19 } },
    ]);
    expect(s.phase).toBe("streaming");
    expect(s.remaining).toBe(19);
    expect(s.chunks).toHaveLength(1);
  });

  it("interleaves text and markers as segments with per-document passage numbers", () => {
    const s = run([
      { type: "submit", question: "q" },
      {
        type: "meta",
        chunks: [chunk(1, "Law 15 › 1"), chunk(2, "Law 15 › 3")],
        remaining: { visitor: 19 },
      },
      { type: "text", delta: "No " },
      { type: "citation", documentIndex: 1, citedText: "second doc first" },
      { type: "text", delta: "— goal kick " },
      { type: "citation", documentIndex: 0, citedText: "first doc second" },
      { type: "citation", documentIndex: 1, citedText: "repeat doc" },
    ]);
    expect(s.segments).toEqual([
      { type: "text", text: "No " },
      { type: "marker", passageNumber: 1, documentIndex: 1 },
      { type: "text", text: "— goal kick " },
      { type: "marker", passageNumber: 2, documentIndex: 0 },
      { type: "marker", passageNumber: 1, documentIndex: 1 },
    ]);
    // passages: first-cited document gets [1]; repeat citation of the same
    // document appends its citedText to the existing passage, not a new one
    expect(s.passages.map((p) => p.passageNumber)).toEqual([1, 2]);
    expect(s.passages[0].breadcrumb).toBe("Law 15 › 3");
  });

  it("completes on done, keeping remaining and cited indexes", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1")], remaining: { visitor: 19 } },
      { type: "text", delta: "answer" },
      { type: "done", citedDocumentIndexes: [0] },
    ]);
    expect(s.phase).toBe("completed");
    expect(s.citedDocumentIndexes).toEqual([0]);
  });

  it("keeps partial text on stream_error (failed_partial)", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "partial " },
      { type: "stream_error", message: "something went wrong, please try again shortly" },
    ]);
    expect(s.phase).toBe("failed_partial");
    expect(s.segments).toEqual([{ type: "text", text: "partial " }]);
    expect(s.message).toContain("try again");
  });

  it("handles gated responses with chunks and maxSimilarity", () => {
    const s = run([
      { type: "submit", question: "lbw?" },
      {
        type: "gated",
        message: "I can only answer questions about the Laws of the Game.",
        chunks: [chunk(1, "Law 11 › 1")],
        maxSimilarity: 0.31,
        remaining: { visitor: 18 },
      },
    ]);
    expect(s.phase).toBe("gated");
    expect(s.maxSimilarity).toBe(0.31);
    expect(s.remaining).toBe(18);
  });

  it("records limit scope on rate_limited", () => {
    const s = run([
      { type: "submit", question: "q" },
      {
        type: "rate_limited",
        scope: "global",
        message: "The demo's daily budget is used up — please come back tomorrow.",
      },
    ]);
    expect(s.phase).toBe("limited");
    expect(s.limitScope).toBe("global");
  });

  it("refusal ends refused with no partial-answer debris", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "should be discarded" },
      { type: "refusal" },
    ]);
    expect(s.phase).toBe("refused");
    expect(s.segments).toEqual([]);
  });

  it("stays refused when the stream's trailing done event follows a refusal", () => {
    // streamAnswer (lib/answer.ts) always yields a `done` event right after
    // `refusal` — the real event sequence never stops at `refusal` alone.
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "should be discarded" },
      { type: "refusal" },
      { type: "done", citedDocumentIndexes: [] },
    ]);
    expect(s.phase).toBe("refused");
    expect(s.segments).toEqual([]);
  });

  it("reset returns to initial state but keeps remaining", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "done", citedDocumentIndexes: [] },
      { type: "reset" },
    ]);
    expect(s.phase).toBe("idle");
    expect(s.remaining).toBe(19);
  });
});

describe("historyEntryMessage", () => {
  it("returns the gate message for a gated entry", () => {
    const s = run([
      { type: "submit", question: "lbw?" },
      {
        type: "gated",
        message: "I can only answer questions about the Laws of the Game.",
        chunks: [chunk(1, "Law 11 › 1")],
        maxSimilarity: 0.31,
        remaining: { visitor: 18 },
      },
    ]);
    expect(historyEntryMessage(s)).toBe("I can only answer questions about the Laws of the Game.");
  });

  it("returns the standard decline copy for a refused entry", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1")], remaining: { visitor: 19 } },
      { type: "text", delta: "should be discarded" },
      { type: "refusal" },
    ]);
    expect(historyEntryMessage(s)).toBe(REFUSED_MESSAGE);
  });

  it("returns null for a completed entry", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "answer" },
      { type: "done", citedDocumentIndexes: [] },
    ]);
    expect(historyEntryMessage(s)).toBeNull();
  });
});
