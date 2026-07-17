import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Fixed constant, deliberately NOT ANSWER_MODEL(): upgrading the answering
// model must never silently make the splitter 25x more expensive (spec §4).
export const DECOMPOSE_MODEL = "claude-haiku-4-5";
export const MAX_SUB_QUESTIONS = 4;
export const DECOMPOSE_TIMEOUT_MS = 4_000; // was 3_000 -- a real measured call was clipped at exactly 3000ms by this timeout (Task 5, second measurement pass)
export const MAX_DECOMPOSE_TOKENS = 512;

// Route-level deadline (app/api/ask/route.ts) for how long /api/ask waits on
// this call before proceeding as simple for the current request — NOT a
// property of decompose() itself, whose own contract (never rejects, this
// file's ~4s hard budget above) is unchanged. See spec §3/§4/§7/§10.4.
// 2500ms is the working value validated by Task 5's second measurement pass
// (n=72 dedicated sample, spec §10.4) — not the original 800ms guess.
export const DECOMPOSE_SOFT_DEADLINE_MS = 2_500;

// Instructions only — the visitor's question goes in the user message as
// data, never concatenated here (spec §8).
export const DECOMPOSE_SYSTEM_PROMPT = `You split questions about the Laws of the Game (football/soccer rules) into retrieval-friendly sub-questions.

Return JSON: {"sub_questions": [...]}.

Rules:
- If the question asks about one rule or concept, return exactly one item: the question itself, unchanged.
- If it combines several distinct rules or scenarios, split it into 2-4 self-contained sub-questions, each answerable from a single section of the Laws.
- Each sub-question must stand alone: name its subject explicitly (no "it", "they", "that case").
- Never answer the question. Never invent sub-questions about topics the question does not raise.`;

const SUB_QUESTIONS_SCHEMA = {
  type: "object",
  properties: { sub_questions: { type: "array", items: { type: "string" } } },
  required: ["sub_questions"],
  additionalProperties: false,
};

export function parseSubQuestions(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const list = (parsed as { sub_questions?: unknown }).sub_questions;
  if (!Array.isArray(list)) return null;
  const cleaned = list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_SUB_QUESTIONS);
  return cleaned.length === 0 ? null : cleaned;
}

// Resolves to 1-4 sub-questions, or null meaning "take the simple path".
// Never rejects: the decomposer is an optimization, not a dependency —
// every failure mode must land on today's exact behavior (spec §6).
export async function decompose(question: string, client?: Anthropic): Promise<string[] | null> {
  try {
    const activeClient = client ?? new Anthropic();
    const response = await activeClient.messages.create(
      {
        model: DECOMPOSE_MODEL,
        max_tokens: MAX_DECOMPOSE_TOKENS,
        system: DECOMPOSE_SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: SUB_QUESTIONS_SCHEMA } },
        messages: [{ role: "user", content: question }],
      },
      { timeout: DECOMPOSE_TIMEOUT_MS, maxRetries: 0 },
    );
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? parseSubQuestions(block.text) : null;
  } catch (err) {
    console.error("decompose failed", { question: question.slice(0, 80), err });
    return null;
  }
}
