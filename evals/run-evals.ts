import { readFile } from "node:fs/promises";
import { searchChunks } from "../lib/retrieval";

interface Golden {
  question: string;
  expected: string[];
}

// Segment-aware prefix match: "Law 1" must match "Law 1 › ..." but never
// "Law 11 › ..." (PR #1 review finding — bare startsWith was digit-prefix unsafe).
export function matchesExpected(breadcrumb: string, expected: string): boolean {
  return (
    breadcrumb === expected ||
    breadcrumb.startsWith(expected + " ") ||
    breadcrumb.startsWith(expected + ".")
  );
}

export function scoreQuestion(chunks: { breadcrumb: string }[], expected: string[]): number {
  const idx = chunks.findIndex((c) => expected.some((e) => matchesExpected(c.breadcrumb, e)));
  return idx === -1 ? 0 : idx + 1;
}

// AND-semantics counterpart to scoreQuestion (which is OR: any expected
// section counts). A compound question is fully answerable only if EVERY
// required section has at least one chunk in the top-k. Spec:
// docs/superpowers/specs/2026-07-14-compound-question-eval-design.md §4.
export function coverageScore(
  chunks: { breadcrumb: string }[],
  required: string[],
): { coverage: number; missed: string[] } {
  const missed = required.filter((r) => !chunks.some((c) => matchesExpected(c.breadcrumb, r)));
  return {
    coverage: required.length === 0 ? 1 : (required.length - missed.length) / required.length,
    missed,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Voyage's free tier (no payment method on file) is rate-limited to 3 requests/minute.
// Retry with backoff on 429s so the eval run survives the free-tier limit end to end.
async function searchWithRetry(question: string, k: number, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await searchChunks(question, k);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("429") || attempt === maxAttempts) throw err;
      const backoffMs = 20_000 * attempt;
      console.error(
        `  (rate limited, retry ${attempt}/${maxAttempts - 1} in ${backoffMs / 1000}s)`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("unreachable");
}

interface AbstainQuestion {
  question: string;
}

async function runGoldenSet(
  label: string,
  goldens: Golden[],
): Promise<{ hits: number; mrrSum: number; maxSims: number[] }> {
  let hits = 0;
  let mrrSum = 0;
  const maxSims: number[] = [];
  for (const g of goldens) {
    const result = await searchWithRetry(g.question, 8);
    maxSims.push(result.maxSimilarity);
    const rank = scoreQuestion(result.chunks, g.expected);
    if (rank > 0) {
      hits += 1;
      mrrSum += 1 / rank;
    }
    console.log(
      `${rank > 0 ? `hit@${rank}` : "MISS "}  maxSim=${result.maxSimilarity.toFixed(3)}  ${g.question}`,
    );
  }
  console.log(
    `\n[${label}] recall@8: ${hits}/${goldens.length} = ${((hits / goldens.length) * 100).toFixed(1)}%` +
      `  MRR: ${(mrrSum / goldens.length).toFixed(3)}`,
  );
  return { hits, mrrSum, maxSims };
}

async function main() {
  const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
  const paraphrases: Golden[] = JSON.parse(
    await readFile("evals/paraphrase-questions.json", "utf8"),
  );
  const abstains: AbstainQuestion[] = JSON.parse(
    await readFile("evals/abstain-questions.json", "utf8"),
  );

  console.log("=== Golden set (baseline defense) ===");
  const golden = await runGoldenSet("golden", goldens);

  console.log("\n=== Paraphrase set (informational — self-authored-bias gap) ===");
  await runGoldenSet("paraphrase", paraphrases);

  console.log("\n=== Abstain set (should be gated) ===");
  const offTopicSims: number[] = [];
  for (const a of abstains) {
    const result = await searchWithRetry(a.question, 8);
    offTopicSims.push(result.maxSimilarity);
    console.log(`maxSim=${result.maxSimilarity.toFixed(3)}  ${a.question}`);
  }

  const minOnTopic = Math.min(...golden.maxSims);
  const maxOffTopic = Math.max(...offTopicSims);
  console.log("\n=== Gate calibration ===");
  console.log(`min on-topic maxSimilarity:  ${minOnTopic.toFixed(3)}`);
  console.log(`max off-topic maxSimilarity: ${maxOffTopic.toFixed(3)}`);
  console.log(
    minOnTopic > maxOffTopic
      ? `separable — midpoint threshold candidate: ${((minOnTopic + maxOffTopic) / 2).toFixed(3)}`
      : "NOT separable — tiers overlap; flag to Markus before choosing a threshold",
  );
}

if (process.argv[1]?.endsWith("run-evals.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
