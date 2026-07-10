import { readFile } from "node:fs/promises";
import { searchChunks } from "../lib/retrieval";

interface Golden {
  question: string;
  expected: string[];
}

export function scoreQuestion(chunks: { breadcrumb: string }[], expected: string[]): number {
  const idx = chunks.findIndex((c) => expected.some((e) => c.breadcrumb.startsWith(e)));
  return idx === -1 ? 0 : idx + 1;
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

async function main() {
  const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
  let hits = 0;
  let mrrSum = 0;

  for (const g of goldens) {
    const { chunks } = await searchWithRetry(g.question, 8);
    const rank = scoreQuestion(chunks, g.expected);
    if (rank > 0) {
      hits += 1;
      mrrSum += 1 / rank;
    }
    console.log(`${rank > 0 ? `hit@${rank}` : "MISS "}  ${g.question}`);
  }

  console.log(
    `\nrecall@8: ${hits}/${goldens.length} = ${((hits / goldens.length) * 100).toFixed(1)}%`,
  );
  console.log(`MRR:      ${(mrrSum / goldens.length).toFixed(3)}`);
}

if (process.argv[1]?.endsWith("run-evals.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
