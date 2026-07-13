import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { documentBlocks, streamAnswer, type AnswerEvent } from "../lib/answer";
import type { RetrievedChunk } from "../lib/retrieval";

const chunk = (id: number, breadcrumb: string): RetrievedChunk => ({
  id,
  law_number: 11,
  breadcrumb,
  content: `content of ${breadcrumb}`,
  similarity: 0.5,
  rrf_score: 0.03,
});

describe("documentBlocks", () => {
  it("maps each chunk to a citations-enabled plain-text document", () => {
    const blocks = documentBlocks([chunk(1, "Law 11 › 1. Offside position")]);
    expect(blocks).toEqual([
      {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: "content of Law 11 › 1. Offside position",
        },
        title: "Law 11 › 1. Offside position",
        citations: { enabled: true },
      },
    ]);
  });
});

// A minimal fake of the SDK's MessageStream: async-iterable over raw stream
// events plus finalMessage(). Shapes match the Messages API streaming format.
function fakeStream(events: unknown[], stopReason: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* events;
    },
    finalMessage: async () => ({ stop_reason: stopReason }),
  };
}

const textDelta = (text: string) => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
});

const citationDelta = (documentIndex: number) => ({
  type: "content_block_delta",
  index: 0,
  delta: {
    type: "citations_delta",
    citation: {
      type: "char_location",
      cited_text: "cited words",
      document_index: documentIndex,
      document_title: "Law 11 › 1. Offside position",
      start_char_index: 0,
      end_char_index: 11,
    },
  },
});

const clientYielding = (events: unknown[], stopReason = "end_turn") =>
  ({
    messages: { stream: () => fakeStream(events, stopReason) },
  }) as unknown as Anthropic;

async function collect(gen: AsyncGenerator<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("streamAnswer", () => {
  const chunks = [chunk(1, "Law 11 › 1. Offside position"), chunk(2, "Law 15 › 1. Procedure")];

  it("yields text deltas, citations, and a done event with cited indexes", async () => {
    const events = await collect(
      streamAnswer(
        "q",
        chunks,
        clientYielding([textDelta("A player "), citationDelta(0), textDelta("is offside...")]),
      ),
    );
    expect(events).toEqual([
      { type: "text", delta: "A player " },
      {
        type: "citation",
        documentIndex: 0,
        citedText: "cited words",
        startCharIndex: 0,
        endCharIndex: 11,
      },
      { type: "text", delta: "is offside..." },
      { type: "done", citedDocumentIndexes: [0], stopReason: "end_turn" },
    ]);
  });

  it("deduplicates cited document indexes in done", async () => {
    const events = await collect(
      streamAnswer(
        "q",
        chunks,
        clientYielding([citationDelta(1), citationDelta(1), citationDelta(0)]),
      ),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: "done", citedDocumentIndexes: [0, 1], stopReason: "end_turn" });
  });

  it("yields a refusal event before done when Claude declines", async () => {
    const events = await collect(streamAnswer("q", chunks, clientYielding([], "refusal")));
    expect(events).toEqual([
      { type: "refusal" },
      { type: "done", citedDocumentIndexes: [], stopReason: "refusal" },
    ]);
  });
});
