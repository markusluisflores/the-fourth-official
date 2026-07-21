# Generation Grounding Gap Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #65 so the model reliably hedges instead of asserting
unsupported rulings when retrieved passages are topically relevant but
scenario-mismatched, and add generation-level verification that didn't
exist before (the eval suite currently tests retrieval recall only).

**Architecture:** Set `temperature: 0` on the answer-generation call and
harden the system prompt's grounding instruction. Add a new generation
harness (`evals/generation-harness.ts`) that runs real retrieval +
real generation for a question and reports which sources actually got
cited. Wire that into a new opt-in `--generation` mode in
`evals/run-evals.ts`: an automated completeness check (does the generated
answer cite every required source) for golden/paraphrase/compound
questions, and a manual-review hedging check for a new
`evals/hedge-questions.json` set.

**Tech Stack:** TypeScript, `tsx` (eval script runner), Anthropic SDK
(`@anthropic-ai/sdk`), Vitest.

## Global Constraints

- Never call the generation model in the default (free, retrieval-only)
  `npm run eval` path — all generation-level checks live behind a new
  `--generation` flag, mirroring the existing `--decompose` opt-in
  pattern (paid, not part of the default run).
- `temperature: 0` at the answer-generation call site, per spec §4.2.1 —
  never a low-nonzero value.
- Never edit `lib/retrieval.ts`, `match_chunks`, or `RELEVANCE_THRESHOLD`
  — this is a generation-only fix (spec §3 non-goals).
- The hedge-set check is manual-review, not automated pass/fail — print
  full answer text for a human/agent to judge, per spec §4.2.5. Do not
  build keyword-matching or an LLM-judge for this.
- Full spec: `docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`
  (approved — do not deviate from its approach without a plan revision on
  its own docs branch, per this project's spec/plan-revision rule).
- All shell commands in this plan are POSIX `sh` syntax — run via a
  Bash-style tool, not PowerShell, on this Windows machine.
- As of this plan's authoring (2026-07-20), `main` has 30 golden questions
  and 14 compound questions — PR #72 (issue #64's fix, which adds 2 more
  golden sentinels) had not yet merged. If PR #72 merges before this plan
  executes, the golden count will be 32; adjust expected counts in Task 6
  accordingly and note it in that task's report — do not treat a count
  mismatch as a plan bug without checking `main`'s state first.

---

### Task 1: `lib/answer.ts` — temperature control, prompt hardening, cited-breadcrumb helper

**Files:**
- Modify: `lib/answer.ts`
- Test: `tests/answer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TEMPERATURE` (exported constant, `0`), `streamAnswer`'s 4th
  parameter `temperature: number = TEMPERATURE`, and a new exported
  function `citedBreadcrumbs(chunks: RetrievedChunk[], citedDocumentIndexes: number[]): string[]`
  — both consumed by Task 2's harness.

- [ ] **Step 1: Write the failing tests**

Add to `tests/answer.test.ts`, after the existing `documentBlocks` describe
block:

```ts
describe("citedBreadcrumbs", () => {
  it("maps cited document indexes back to their chunk breadcrumbs", () => {
    const chunks = [chunk(1, "Law 11 › 1. Offside position"), chunk(2, "Law 15 › 1. Procedure")];
    expect(citedBreadcrumbs(chunks, [1, 0])).toEqual([
      "Law 15 › 1. Procedure",
      "Law 11 › 1. Offside position",
    ]);
  });

  it("returns an empty array when nothing was cited", () => {
    expect(citedBreadcrumbs([chunk(1, "Law 11 › 1. Offside position")], [])).toEqual([]);
  });
});
```

Add to the end of the `streamAnswer` describe block (after the last
existing `it`, before its closing `});`):

```ts
  it("passes temperature 0 to the underlying API call by default", async () => {
    const stream = vi.fn(() => fakeStream([], "end_turn"));
    const client = { messages: { stream } } as unknown as Anthropic;
    await collect(streamAnswer("q", chunks, client));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it("passes a temperature override through to the underlying API call", async () => {
    const stream = vi.fn(() => fakeStream([], "end_turn"));
    const client = { messages: { stream } } as unknown as Anthropic;
    await collect(streamAnswer("q", chunks, client, 1));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ temperature: 1 }));
  });
```

Update the import line at the top of `tests/answer.test.ts`:

```ts
import { citedBreadcrumbs, documentBlocks, streamAnswer, type AnswerEvent } from "../lib/answer";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/answer.test.ts`
Expected: FAIL — `citedBreadcrumbs` is not exported (does not exist yet),
and the two new `streamAnswer` tests fail because `temperature` is never
passed to `client.messages.stream()`.

- [ ] **Step 3: Implement**

In `lib/answer.ts`, add the `TEMPERATURE` constant right after the
existing `MAX_ANSWER_TOKENS` line (currently line 7), before
`SYSTEM_PROMPT`:

```ts
// Temperature 0: this app's entire premise is "answer strictly from
// retrieved passages, never invent" — there is no scenario where creative
// sampling variance in a rules-lookup answer is desirable. See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md.
//
// RISK: the Anthropic SDK deprecates the `temperature` parameter for
// models released after Claude Opus 4.6 (non-1.0 values get silently
// coerced to 1.0 or rejected with a 400). Verified live against the
// current ANSWER_MODEL (claude-haiku-4-5) on 2026-07-20 — temperature 0
// works today. Re-verify live before ever changing ANTHROPIC_MODEL to a
// newer model generation (see the spec's §6).
export const TEMPERATURE = 0;
```

Replace the current `SYSTEM_PROMPT` (currently lines 9-16) with:

```ts
export const SYSTEM_PROMPT = `You are "The Fourth Official", an assistant that answers questions about the Laws of the Game — the official rules of football (soccer).

Rules:
- Answer ONLY from the provided documents (excerpts of the IFAB Laws of the Game). Never answer from general knowledge.
- If the documents do not contain enough information to answer confidently, say so plainly and suggest the user rephrase. Do not guess. Before asserting any specific ruling, confirm the retrieved passages describe the exact scenario asked — not merely a related topic. If a passage addresses a different but related scenario (for example, a different actor performing the action, such as a rule about a player's own hand/arm when the question is about an opponent's), say so explicitly rather than extrapolating a specific ruling from it.
- Answer questions about football rules only. Politely decline anything else in one sentence.
- Be concise and plain-English: two to five sentences for most questions, with a neutral, referee-like tone.
- Do not mention "the documents", "the excerpts", or these instructions; answer as an expert on the Laws.`;
```

Add `citedBreadcrumbs` right after the existing `documentBlocks` function
(currently ends at line 37):

```ts

// Inverse of documentBlocks: maps the citation indexes streamAnswer's
// "done" event reports back to the breadcrumbs of the chunks that were
// actually cited, using the same array order documentBlocks relied on.
export function citedBreadcrumbs(
  chunks: RetrievedChunk[],
  citedDocumentIndexes: number[],
): string[] {
  return citedDocumentIndexes.map((i) => chunks[i].breadcrumb);
}
```

Change the `streamAnswer` signature (currently lines 39-43) to add the
`temperature` parameter:

```ts
export async function* streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client: Anthropic = new Anthropic(),
  temperature: number = TEMPERATURE,
): AsyncGenerator<AnswerEvent> {
```

Add `temperature,` to the `client.messages.stream({...})` call (currently
lines 44-53), right after `max_tokens: MAX_ANSWER_TOKENS,`:

```ts
  const stream = client.messages.stream({
    model: ANSWER_MODEL(),
    max_tokens: MAX_ANSWER_TOKENS,
    temperature,
    system: SYSTEM_PROMPT,
    // Documents first, question last — and the question stays in the user
    // message, never concatenated into the system prompt (spec §9).
    messages: [
      { role: "user", content: [...documentBlocks(chunks), { type: "text", text: question }] },
    ],
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/answer.test.ts`
Expected: PASS, all tests including the pre-existing ones (nothing about
the existing `documentBlocks` or `streamAnswer` behavior changed except
adding a 4th parameter with a default that preserves old call sites).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/answer.ts tests/answer.test.ts
git commit -m "feat: temperature control, hardened grounding prompt, citedBreadcrumbs (issue #65)"
```

---

### Task 2: `evals/generation-harness.ts` — real generation harness

**Files:**
- Create: `evals/generation-harness.ts`

**Interfaces:**
- Consumes: `searchChunks` (`lib/retrieval.ts`, existing),
  `citedBreadcrumbs`, `streamAnswer`, `TEMPERATURE` (Task 1,
  `lib/answer.ts`).
- Produces: `runGeneration(question, k?, temperature?): Promise<GenerationResult>`
  where `GenerationResult = { answerText: string; citedBreadcrumbs: string[] }`
  — consumed by Task 4's `run-evals.ts` changes.

This is a thin composition of two existing live-service calls (retrieval,
then generation) — not unit-tested, same precedent as
`scripts/ingest/index.ts` (an operational script verified by running it,
not by Vitest). Its own verification is Task 6's live run.

- [ ] **Step 1: Write the file**

```ts
import { searchChunks } from "../lib/retrieval";
import { citedBreadcrumbs, streamAnswer, TEMPERATURE } from "../lib/answer";

export interface GenerationResult {
  answerText: string;
  citedBreadcrumbs: string[];
}

// Runs the REAL generation step (not just retrieval) for one question.
// Used by run-evals.ts's --generation mode to check what a generated
// answer actually cites and says, not just what retrieval surfaced.
// Costs one real Anthropic call per invocation — unlike the rest of the
// eval suite (Voyage-only, free). See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md §4.2.3.
export async function runGeneration(
  question: string,
  k = 8,
  temperature: number = TEMPERATURE,
): Promise<GenerationResult> {
  const { chunks } = await searchChunks(question, k);
  let answerText = "";
  let citedDocumentIndexes: number[] = [];
  for await (const event of streamAnswer(question, chunks, undefined, temperature)) {
    if (event.type === "text") answerText += event.delta;
    if (event.type === "done") citedDocumentIndexes = event.citedDocumentIndexes;
  }
  return { answerText, citedBreadcrumbs: citedBreadcrumbs(chunks, citedDocumentIndexes) };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add evals/generation-harness.ts
git commit -m "feat: add real-generation eval harness (issue #65)"
```

---

### Task 3: `evals/compound-questions.json` — two new multi-citation entries

**Files:**
- Modify: `evals/compound-questions.json`

**Interfaces:** none — pure data file edit.

Both entries below were verified against the live `chunks` table
(Supabase project `moybkceeltzwnyiaasys`, `corpus_version = '2025-26'`)
on 2026-07-20 — the cited breadcrumbs exist and their content supports the
question as written.

- [ ] **Step 1: Add a comma to the current last entry**

The file's current last entry (line 71, no trailing comma since it's the
last array element):

```json
    "note": "Tests whether retrieval surfaces the simultaneous-offense precedence rule (Law 5) alongside the handball offense definition itself (Law 12) — a real professional refereeing dispute about which infringement 'wins' when two happen in the same passage of play. Harvested from a real disputed 2026-07-19 incident (see issue #64/#65 comments)."
  }
]
```

Add a comma after that closing `}`, then append the two new entries
below, before the closing `]`:

```json
    "note": "Tests whether retrieval surfaces the simultaneous-offense precedence rule (Law 5) alongside the handball offense definition itself (Law 12) — a real professional refereeing dispute about which infringement 'wins' when two happen in the same passage of play. Harvested from a real disputed 2026-07-19 incident (see issue #64/#65 comments)."
  },
  {
    "question": "If the referee allows play to continue under advantage for a foul that would have warranted a red card, does the player still get sent off once the advantage phase ends?",
    "required": ["Law 5 › 3", "Law 12 › 4"],
    "note": "Law 5 › 3's advantage clause (the referee's authority to let play continue) and Law 12 › 4's explicit statement that a caution/sending-off already earned is not cancelled by playing advantage are two separate sections a full answer needs. Added issue #65 (generation-grounding fix) as a new generation-completeness test case, verified against the live corpus 2026-07-20."
  },
  {
    "question": "If a player who is already on a yellow card receives a second caution later in the same match and is sent off, can their team substitute another player in to replace them?",
    "required": ["Law 3 › 6", "Law 12 › 4"],
    "note": "Law 12 › 4 lists 'receiving a second caution in the same match' as a sending-off offence; Law 3 › 6 separately states a player sent off after kick-off cannot be replaced. A full answer needs both. Added issue #65 (generation-grounding fix) as a new generation-completeness test case, verified against the live corpus 2026-07-20."
  }
]
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('evals/compound-questions.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add evals/compound-questions.json
git commit -m "test: add 2 multi-citation compound questions for generation completeness (issue #65)"
```

---

### Task 4: `evals/run-evals.ts` — wire the `--generation` mode

**Files:**
- Modify: `evals/run-evals.ts`
- Test: `tests/evals.test.ts`

**Interfaces:**
- Consumes: `runGeneration` (Task 2, `evals/generation-harness.ts`),
  `TEMPERATURE` (Task 1, `lib/answer.ts`), `coverageScore` (existing, this
  file).
- Produces: `parseTemperatureArg(): number`, `parseRepeatArg(): number` —
  pure, exported for testing. `runGenerationCompletenessSet` and
  `runHedgeSet` are internal orchestration (not exported, not unit
  tested — same live-service precedent as `runGoldenSet`/`runCompoundSet`
  already in this file).

- [ ] **Step 1: Write the failing tests for the two pure argv parsers**

Add to `tests/evals.test.ts`:

```ts
import { parseRepeatArg, parseTemperatureArg } from "../evals/run-evals";

describe("parseTemperatureArg", () => {
  it("defaults to TEMPERATURE (0) when --temperature is absent", () => {
    expect(parseTemperatureArg(["node", "run-evals.ts", "--generation"])).toBe(0);
  });

  it("parses an explicit --temperature=N value", () => {
    expect(parseTemperatureArg(["node", "run-evals.ts", "--generation", "--temperature=1"])).toBe(
      1,
    );
  });
});

describe("parseRepeatArg", () => {
  it("defaults to 1 when --repeat is absent", () => {
    expect(parseRepeatArg(["node", "run-evals.ts"])).toBe(1);
  });

  it("parses an explicit --repeat=N value", () => {
    expect(parseRepeatArg(["node", "run-evals.ts", "--repeat=5"])).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/evals.test.ts`
Expected: FAIL — `parseTemperatureArg` and `parseRepeatArg` are not
exported (do not exist yet).

- [ ] **Step 3: Implement**

Add the import for the new harness and `TEMPERATURE`, and a
`HedgeQuestion` interface, near the top of `evals/run-evals.ts` (after the
existing imports and before the `Golden` interface):

```ts
import { runGeneration } from "./generation-harness";
import { TEMPERATURE } from "../lib/answer";

interface HedgeQuestion {
  question: string;
  note?: string;
}
```

Add the two pure argv-parsing functions, taking `argv` as a parameter
(not reading `process.argv` directly, so they're testable) — place them
near the top-level helper functions, after `matchesExpected`/`scoreQuestion`/`coverageScore`:

```ts
export function parseTemperatureArg(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--temperature="));
  return arg ? Number(arg.split("=")[1]) : TEMPERATURE;
}

export function parseRepeatArg(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--repeat="));
  return arg ? Number(arg.split("=")[1]) : 1;
}
```

Add the two orchestration functions, after the existing
`runCompoundSetDecomposed` function and before `async function main()`:

```ts
async function runGenerationCompletenessSet(
  label: string,
  questions: { question: string; required: string[] }[],
  temperature: number,
): Promise<void> {
  let full = 0;
  for (const q of questions) {
    const { citedBreadcrumbs } = await runGeneration(q.question, 8, temperature);
    const { missed } = coverageScore(
      citedBreadcrumbs.map((breadcrumb) => ({ breadcrumb })),
      q.required,
    );
    if (missed.length === 0) full += 1;
    console.log(
      `${missed.length === 0 ? "FULL " : "MISS "} ${q.required.length - missed.length}/${q.required.length}  ${q.question}`,
    );
    if (missed.length > 0) console.log(`  not cited in answer: ${missed.join(" | ")}`);
  }
  console.log(
    `\n[${label} — generation completeness, temperature=${temperature}] full: ${full}/${questions.length}`,
  );
}

async function runHedgeSet(
  hedges: HedgeQuestion[],
  temperature: number,
  repeat: number,
): Promise<void> {
  for (const h of hedges) {
    console.log(`\n--- ${h.question}`);
    if (h.note) console.log(`  (${h.note})`);
    for (let i = 1; i <= repeat; i++) {
      const { answerText } = await runGeneration(h.question, 8, temperature);
      console.log(`  run ${i}/${repeat}: ${answerText}`);
    }
  }
  console.log(
    `\n[hedge set] ${hedges.length} question(s) x ${repeat} run(s) at temperature=${temperature} — ` +
      `MANUALLY REVIEW each answer above: did it hedge (pass) or assert an unsupported specific ruling (fail)?`,
  );
}
```

Add the new mode dispatch in `main()`, right after the existing
`--decompose` block (before the line `const goldens: Golden[] = ...`):

```ts
  if (process.argv.includes("--generation")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("--generation requires ANTHROPIC_API_KEY (it calls the real answer model)");
    }
    const temperature = parseTemperatureArg(process.argv);
    const repeat = parseRepeatArg(process.argv);
    const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
    const paraphrases: Golden[] = JSON.parse(
      await readFile("evals/paraphrase-questions.json", "utf8"),
    );
    const compounds: CompoundQuestion[] = JSON.parse(
      await readFile("evals/compound-questions.json", "utf8"),
    );
    const hedges: HedgeQuestion[] = JSON.parse(
      await readFile("evals/hedge-questions.json", "utf8"),
    );

    console.log(
      `=== Generation-level checks (temperature=${temperature}; calls the real Anthropic model — not free) ===`,
    );
    console.log("\n=== Golden set — generation completeness ===");
    await runGenerationCompletenessSet(
      "golden",
      goldens.map((g) => ({ question: g.question, required: g.expected })),
      temperature,
    );

    console.log("\n=== Paraphrase set — generation completeness ===");
    await runGenerationCompletenessSet(
      "paraphrase",
      paraphrases.map((g) => ({ question: g.question, required: g.expected })),
      temperature,
    );

    console.log("\n=== Compound set — generation completeness ===");
    await runGenerationCompletenessSet("compound", compounds, temperature);

    console.log("\n=== Hedge set — MANUAL REVIEW REQUIRED (not automated pass/fail) ===");
    await runHedgeSet(hedges, temperature, repeat);
    return;
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/evals.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (This will fail until Task 5 creates
`evals/hedge-questions.json` if you try to run the script — but `tsc`
only checks types, not file existence at runtime, so it passes once the
code compiles.)

- [ ] **Step 6: Commit**

```bash
git add evals/run-evals.ts tests/evals.test.ts
git commit -m "feat: add --generation mode to eval harness (completeness + hedge checks, issue #65)"
```

---

### Task 5: `evals/hedge-questions.json` — scenario-mismatch question set

**Files:**
- Create: `evals/hedge-questions.json`

**Interfaces:** none — pure data file, consumed by Task 4's `runHedgeSet`.

- [ ] **Step 1: Seed with the original, already-proven reproduction question**

```json
[
  {
    "question": "If a player shoots a shot and it bounces off the arm of an opponent, but eventually gets a goal - Should the goal be disallowed and be considered a penalty or should the goal count?",
    "note": "Original issue #65 reproduction question. Retrieved Law 12 › 1 handball text governs a player's OWN hand/arm when scoring — it does not address an opponent's/defender's arm deflecting the ball into the goal. Correct behavior: hedge. Confirmed nondeterministic pre-fix (2026-07-19): one run hedged correctly, an identical retry asserted an unsupported ruling."
  }
]
```

This one entry alone already directly tests the exact regression issue
#65 reports — everything past this step is coverage expansion, not a
requirement for the fix's correctness.

- [ ] **Step 2: Bounded investigation for additional genuine gaps**

Two candidates were already checked during this plan's authoring
(2026-07-20) and found NOT usable — both retrieved passages that
explicitly cover the exact scenario, so they don't create the ambiguity a
hedge test needs:

- *"If the ball deflects off a defender and falls to an attacking player
  in an offside position, does that cancel the offside?"* — `Law 11 › 2`
  already explicitly distinguishes deflection/rebound from deliberate
  play. Well covered.
- *"If a player throws the ball into their own goal directly from a
  throw-in, does the goal count?"* — `Law 15 › Introduction` already
  explicitly states "if the ball enters the thrower's goal – a corner
  kick is awarded." Well covered.

Try up to 3 more candidates using the same pattern as the original bug —
a rule stated for one specific actor that the model might misapply to a
different actor. Two untested starting candidates:

- *"If the ball touches a defender's arm and goes out for a corner kick
  instead of resulting in a goal, is that still a handball offence even
  though no goal was scored?"*
- *"Does the goalkeeper's own-hand/arm scoring restriction apply the same
  way if the goalkeeper is the one who concedes an own goal off their own
  arm, versus scoring in the opponents' goal?"*

For each candidate (the two above, plus any you invent following the same
pattern): run `searchChunks(question, 8)` from `lib/retrieval.ts`
directly (a throwaway script is fine, same pattern as issue #64's
dry-run scripts — write it, run it, delete it, confirm `git status` is
clean of it afterward) and read the actual retrieved passage content. A
candidate is a genuine hit only if the retrieved passages are topically
related (same law / general topic) but do **not** explicitly state a
ruling for the exact scenario asked. If a candidate turns out to be well
covered (like the two dead ends above), discard it and try the next one.

Add any genuine hits found (in the same `{ "question", "note" }` shape as
Step 1, with the note explaining what's retrieved and why it doesn't
cover the exact scenario) to `evals/hedge-questions.json`.

**If none of the 3 additional attempts produce a genuine gap:** that is
an acceptable, documented outcome — do not keep searching past this
budget. Note in your task report which candidates were tried and why each
didn't qualify. Shipping with just the one proven question from Step 1 is
sufficient; per spec §3, this app's corpus being this thorough is a
finding worth recording, not a gap to force.

- [ ] **Step 3: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('evals/hedge-questions.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Confirm no throwaway investigation scripts survived**

Run: `git status --short`
Expected: only `evals/hedge-questions.json` (staged or modified) — no
stray `_tmp-*.ts` files.

- [ ] **Step 5: Commit**

```bash
git add evals/hedge-questions.json
git commit -m "test: add hedge-question set for generation-grounding checks (issue #65)"
```

---

### Task 6: Full verification run — completeness, hedging, temperature comparison

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`
  (revision history table only)

**Interfaces:** none.

This task calls the real Anthropic API repeatedly (roughly 60-70 calls
across all sets combined at default repeat=1, more for the repeated-run
step below) — cheap per call on Haiku, but real cost, not free like the
rest of the eval suite.

- [ ] **Step 1: Run the completeness + single-pass hedge check at temperature 0**

Run: `npm run eval -- --generation`

Expected: golden and paraphrase sets show `full: N/N` (every question's
single required breadcrumb was cited) or close to it — read the actual
output, don't assume. Compound set (16 questions after Task 3) shows a
completeness rate; the two new Task 3 entries are the ones to check most
closely since they're unverified at the generation layer until now.
Hedge set prints one full answer per question for manual review — read
it and judge: did it hedge, or assert a specific unsupported ruling?

**If the golden/paraphrase completeness check shows unexpected misses**
(a single-citation question that used to work now not being cited): stop
and investigate before proceeding — this would mean temperature 0 or the
prompt change regressed something the fix wasn't supposed to touch.

- [ ] **Step 2: Repeated-run hedge check at temperature 0**

Run: `npm run eval -- --generation --repeat=5`

Expected: the (one or more) hedge questions each print 5 answers. Read
all 5 for each question — the fix is working if every run hedges
consistently. This is the direct test of the nondeterminism this issue
reports: the same question, run repeatedly, should no longer sometimes
hedge and sometimes assert a ruling.

**If any run asserts an unsupported specific ruling:** the fix is
incomplete. This is a plan/spec-level finding (temperature 0 alone
wasn't sufficient), not something to patch by re-running until it looks
better — stop and escalate per this project's rules on plan/spec-level
findings, rather than silently iterating.

- [ ] **Step 3: Temperature 1.0 comparison on the hedge set**

Run: `npm run eval -- --generation --temperature=1 --repeat=5`

Expected: for direct before/after comparison, record whether this run
(the pre-fix baseline temperature) shows more inconsistency across the 5
repeats than Step 2's temperature-0 run did.

- [ ] **Step 4: Record results in the spec's revision history**

Add a new row to the revision history table in
`docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`,
with the actual measured results from Steps 1-3 (real numbers and a
real summary of the hedge-set manual review, not placeholder text):
golden/paraphrase/compound completeness rates at temperature 0, the
hedge set's consistency across 5 repeats at temperature 0 versus
temperature 1.0, and confirmation of whether Task 5's investigation found
additional genuine hedge questions or shipped with just the original one.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md
git commit -m "docs: record post-fix generation-grounding verification results (issue #65)"
```

---

## Self-Review Notes

- **Spec coverage:** all of spec §4.2's pieces map to a task — temperature
  + prompt (Task 1), generation harness (Task 2), completeness-check test
  data (Task 3), completeness + hedge check wiring including the
  temperature-comparison flag from §4.2.7 (Task 4), hedge question set
  (Task 5), full verification + results recording (Task 6). The
  temperature-deprecation risk from spec §6 is addressed directly in
  Task 1's code comment.
- **No placeholders:** every step has literal code, exact file
  paths/line targets, exact commands, and exact expected output. Task 5's
  "investigation" step is bounded (try up to 3 more candidates, two
  starting candidates given, explicit stop condition) rather than
  open-ended, and its two already-tried dead ends are documented so the
  implementer doesn't repeat that work.
- **Type consistency:** `citedBreadcrumbs`, `TEMPERATURE`, and
  `streamAnswer`'s 4th `temperature` parameter (Task 1) are the exact
  names Task 2's `runGeneration` imports and uses. `GenerationResult`'s
  `citedBreadcrumbs` field (Task 2) is the exact name Task 4's
  `runGenerationCompletenessSet` destructures. `HedgeQuestion` (Task 4)
  matches the exact shape Task 5's JSON file produces.

## Revision history

| Date | Change |
|---|---|
| 2026-07-20 | Initial plan. |
