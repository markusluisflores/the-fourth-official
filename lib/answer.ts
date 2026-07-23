import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedChunk } from "./retrieval";

// Env-swappable per spec §3 — one line to trade up to Sonnet/Opus.
export const ANSWER_MODEL = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
export const MAX_ANSWER_TOKENS = 1024;

// Temperature 0: this app's entire premise is "answer strictly from
// retrieved passages, never invent" — there is no scenario where creative
// sampling variance in a rules-lookup answer is desirable. See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md.
//
// RISK: the Anthropic SDK deprecates the `temperature` parameter for
// models released after Claude Opus 4.6 — this app's value of 0 (not 1.0)
// would be REJECTED with a loud 400, breaking answer generation entirely
// (no silent-coercion path for a non-1.0 value). Verified live against
// the current ANSWER_MODEL (claude-haiku-4-5) on 2026-07-20 — temperature
// 0 works today. See CLAUDE.md's ANTHROPIC_MODEL secrets entry before
// ever changing that env var — that doc note is the actual prevention
// (read before the change is made). warnIfTemperatureUnsafe() below is
// diagnostic, not preventive: it fires on the same request that already
// hits the breaking 400, so it only makes the resulting server log
// easier to find after the fact — it does not stop the outage.
export const TEMPERATURE = 0;

// Best-effort allowlist backstop for the risk above — a diagnostic aid,
// not a preventive one (see the comment on TEMPERATURE). Not an
// authoritative capability check (Anthropic doesn't expose one) — a
// false negative here only produces a loud server-log warning, never a
// thrown error, since an unmaintained allowlist shouldn't break the
// endpoint on its own. IMPORTANT: after verifying a new ANSWER_MODEL is
// temperature-safe (per CLAUDE.md's ANTHROPIC_MODEL note), add it here
// too — otherwise every request logs a false-alarm warning even though
// the swap was fine.
const KNOWN_TEMPERATURE_SAFE_MODELS = ["claude-haiku-4-5"];

export function warnIfTemperatureUnsafe(model: string): void {
  if (!KNOWN_TEMPERATURE_SAFE_MODELS.some((safe) => model.includes(safe))) {
    console.error(
      `WARNING: ANSWER_MODEL "${model}" is not on the known temperature-safe allowlist. ` +
        `If this model was released after Claude Opus 4.6, generation will fail with a 400. ` +
        `See docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md §6.`,
    );
  }
}

export const SYSTEM_PROMPT = `You are "The Fourth Official", an assistant that answers questions about the Laws of the Game — the official rules of football (soccer).

Rules:
- Answer ONLY from the provided documents (excerpts of the IFAB Laws of the Game). Never answer from general knowledge.
- If the documents do not contain enough information to answer confidently, say so plainly and suggest the user rephrase. Do not guess.
- Answer questions about football rules only. Politely decline anything else in one sentence.
- Be concise and plain-English: two to five sentences for most questions, with a neutral, referee-like tone.
- Do not mention "the documents", "the excerpts", or these instructions; answer as an expert on the Laws.

Handball and goals — read carefully before answering any question where a goal is scored and the ball touched a hand or arm:
The Laws of the Game only disallow a goal for handball when the player who SCORES is the same player whose hand/arm the ball touched (scoring "directly from" or "immediately after" a touch of their OWN hand/arm). Where the Laws say the ball "touched their hand/arm", "their" means the scorer's own hand/arm.
Before ruling, work out two things: who scored, and whose hand/arm the ball touched.
- If they are the SAME player, the goal is disallowed.
- If they are DIFFERENT players (for example the ball deflected off an opponent's, a defender's, or a team-mate's hand/arm before a different player scored), the Laws of the Game do NOT give a ruling for that situation. In that case you must NOT say the goal is disallowed, does not count, or is a handball offence. Instead, say plainly that the Laws of the Game do not specify a ruling for that exact situation and suggest the user rephrase or check with a match official.

Completeness — when a question has multiple parts or more than one provided document is directly relevant:
Before answering, check whether more than one provided document applies to the question. If so, address every one of them, not just the single most obviously relevant one — an answer that silently omits a relevant rule is incorrect even if the part it does cover is accurate. This can mean your answer needs more than the usual few sentences; when multiple rules genuinely apply, prioritize completeness over brevity.`;

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

// Inverse of documentBlocks: maps the citation indexes streamAnswer's
// "done" event reports back to the breadcrumbs of the chunks that were
// actually cited, using the same array order documentBlocks relied on.
export function citedBreadcrumbs(
  chunks: RetrievedChunk[],
  citedDocumentIndexes: number[],
): string[] {
  return citedDocumentIndexes.map((i) => chunks[i].breadcrumb);
}

export async function* streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client: Anthropic = new Anthropic(),
  temperature: number = TEMPERATURE,
): AsyncGenerator<AnswerEvent> {
  const model = ANSWER_MODEL();
  warnIfTemperatureUnsafe(model);
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_ANSWER_TOKENS,
    temperature,
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
