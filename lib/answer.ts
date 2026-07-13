import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedChunk } from "./retrieval";

// Env-swappable per spec §3 — one line to trade up to Sonnet/Opus.
export const ANSWER_MODEL = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
export const MAX_ANSWER_TOKENS = 1024;

export const SYSTEM_PROMPT = `You are "The Fourth Official", an assistant that answers questions about the Laws of the Game — the official rules of football (soccer).

Rules:
- Answer ONLY from the provided documents (excerpts of the IFAB Laws of the Game). Never answer from general knowledge.
- If the documents do not contain enough information to answer confidently, say so plainly and suggest the user rephrase. Do not guess.
- Answer questions about football rules only. Politely decline anything else in one sentence.
- Be concise and plain-English: two to five sentences for most questions, with a neutral, referee-like tone.
- Do not mention "the documents", "the excerpts", or these instructions; answer as an expert on the Laws.`;

export type AnswerEvent =
  | { type: "text"; delta: string }
  | {
      type: "citation";
      documentIndex: number;
      citedText: string;
      startCharIndex: number;
      endCharIndex: number;
    }
  | { type: "refusal" }
  | { type: "done"; citedDocumentIndexes: number[]; stopReason: string | null };

export function documentBlocks(chunks: RetrievedChunk[]): Anthropic.DocumentBlockParam[] {
  return chunks.map((c) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: c.content },
    title: c.breadcrumb,
    citations: { enabled: true },
  }));
}

export async function* streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client: Anthropic = new Anthropic(),
): AsyncGenerator<AnswerEvent> {
  const stream = client.messages.stream({
    model: ANSWER_MODEL(),
    max_tokens: MAX_ANSWER_TOKENS,
    system: SYSTEM_PROMPT,
    // Documents first, question last — and the question stays in the user
    // message, never concatenated into the system prompt (spec §9).
    messages: [
      { role: "user", content: [...documentBlocks(chunks), { type: "text", text: question }] },
    ],
  });

  let finished = false;
  try {
    const cited = new Set<number>();
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      } else if (event.delta.type === "citations_delta") {
        const c = event.delta.citation;
        if (c.type === "char_location") {
          cited.add(c.document_index);
          yield {
            type: "citation",
            documentIndex: c.document_index,
            citedText: c.cited_text,
            startCharIndex: c.start_char_index,
            endCharIndex: c.end_char_index,
          };
        }
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      // Spec §9: explicit branch — the route shows clean fallback copy instead
      // of a broken half-answer.
      yield { type: "refusal" };
    }
    finished = true;
    yield {
      type: "done",
      citedDocumentIndexes: [...cited].sort((a, b) => a - b),
      stopReason: final.stop_reason,
    };
  } finally {
    // Consumer walked away (client disconnect) — stop paying for tokens.
    if (!finished) stream.abort();
  }
}
