import { searchChunks } from "../lib/retrieval";
import { citedBreadcrumbs, streamAnswer, TEMPERATURE } from "../lib/answer";
import { withVoyageRetry } from "./voyage-retry";

export interface GenerationResult {
  answerText: string;
  citedBreadcrumbs: string[];
}

// Runs the REAL generation step (not just retrieval) for one question.
// Used by run-evals.ts's --generation mode to check what a generated
// answer actually cites and says, not just what retrieval surfaced.
// Costs one real Anthropic call per invocation — unlike the rest of the
// eval suite (Voyage-only, free). The retrieval half is wrapped in
// withVoyageRetry for the same free-tier rate-limit reason every other
// retrieval call in this eval suite is. See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md §4.2.3.
export async function runGeneration(
  question: string,
  k = 8,
  temperature: number = TEMPERATURE,
): Promise<GenerationResult> {
  const { chunks } = await withVoyageRetry(() => searchChunks(question, k));
  let answerText = "";
  let citedDocumentIndexes: number[] = [];
  for await (const event of streamAnswer(question, chunks, undefined, temperature)) {
    if (event.type === "text") answerText += event.delta;
    if (event.type === "done") citedDocumentIndexes = event.citedDocumentIndexes;
  }
  return { answerText, citedBreadcrumbs: citedBreadcrumbs(chunks, citedDocumentIndexes) };
}
