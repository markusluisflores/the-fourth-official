# Compound-Question Eval Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compound-question eval tier that measures, with AND-semantics coverage and a multi-k diagnostic, how well single-pass retrieval covers questions whose full answer spans several law sections — and record the honest baseline.

**Architecture:** Everything is eval-side: a new questions file with `required[]` AND-semantics, one new pure scoring function beside the existing ones in `evals/run-evals.ts`, a new tier loop in `main()` that runs each question at k=8/12/16/24, and documentation of the measured baseline. Production retrieval is untouched.

**Tech Stack:** TypeScript strict · Vitest · the existing eval harness (`tsx` via `npm run eval`) · Supabase RPC `match_chunks` via `lib/retrieval.ts` (read-only consumer).

**Spec:** `docs/superpowers/specs/2026-07-14-compound-question-eval-design.md` (approved 2026-07-14).

## Global Constraints

- **Production retrieval is frozen.** No edits to `lib/retrieval.ts`, `match_chunks`, `RELEVANCE_THRESHOLD`, or production k=8. Only `evals/`, `tests/`, `README.md`, and the two docs named in Task 3 change.
- **The tier is informational, never a gate.** It must not fail the eval run, set a non-zero exit code, or alter the golden/paraphrase/abstain output.
- **`required` is an AND-list** (every section must be found in the top-k), unlike the golden set's `expected` OR-list. Do not reuse `scoreQuestion` for it.
- **Multi-k runs use separate retrieval calls per k** — never fetch k=24 once and slice prefixes (RRF ranking is not guaranteed prefix-stable across `match_count`).
- **Human gate:** the baseline run (Task 3) must not start until Markus has explicitly approved `evals/compound-questions.json` — both the questions and their `required` labels — in that session. This is a hard STOP.
- Branch: `feat/compound-eval-tier` off `main` **after PR #32 is merged** (the spec must be on `main`). TypeScript strict; `npm test`, `npx tsc --noEmit`, `npm run lint` green before every commit.
- Timing note: the full eval run makes ~82 Voyage calls; on the free tier (3/min) expect ~30 minutes. The existing `searchWithRetry` backoff handles the 429s — let it run.
- Risk tier: **Standard** (eval harness). Per-task two-stage review + final `reviewer` agent per the global workflow.

## File Structure

```
evals/compound-questions.json    Task 2 — create: 9 questions with required[] labels
evals/run-evals.ts               Task 1 — add coverageScore; Task 2 — add compound tier to main()
tests/evals.test.ts              Task 1 — coverageScore unit tests
README.md                        Task 3 — Known limitations section
docs/superpowers/specs/2026-07-14-compound-question-eval-design.md   Task 3 — baseline table + revision row
docs/project-reviewer.md         Task 3 — measured numbers into the existing lesson bullet
```

---

### Task 1: `coverageScore` — AND-semantics coverage scoring [Standard tier]

**Files:**
- Modify: `evals/run-evals.ts` (add one exported function after `scoreQuestion`, which ends at line 22)
- Test: `tests/evals.test.ts`

**Interfaces:**
- Consumes: `matchesExpected(breadcrumb: string, expected: string): boolean` (already exported from `evals/run-evals.ts`).
- Produces: `coverageScore(chunks: { breadcrumb: string }[], required: string[]): { coverage: number; missed: string[] }` — `coverage` is the fraction of `required` sections with at least one matching chunk (1 when `required` is empty), `missed` lists the required sections not found, in input order. Task 2 relies on this exact signature.

- [ ] **Step 1: Write the failing tests**

Append to `tests/evals.test.ts` (the `crumbs` helper and imports already exist at the top of the file; extend the import line):

```ts
// change line 2 to:
import { coverageScore, matchesExpected, scoreQuestion } from "../evals/run-evals";
```

```ts
describe("coverageScore", () => {
  it("reports full coverage when every required section is present", () => {
    const result = coverageScore(
      crumbs("Law 3 › 1. Number of players", "Law 10 › 2. Winning team"),
      ["Law 3 › 1", "Law 10 › 2"],
    );
    expect(result).toEqual({ coverage: 1, missed: [] });
  });

  it("names the missed sections and computes the found fraction", () => {
    const result = coverageScore(
      crumbs("Law 3 › 1. Number of players", "Law 12 › 4. Disciplinary action"),
      ["Law 3 › 1", "Law 10 › 2", "Law 10 › 3"],
    );
    expect(result.missed).toEqual(["Law 10 › 2", "Law 10 › 3"]);
    expect(result.coverage).toBeCloseTo(1 / 3);
  });

  it("counts a section found once even when several chunks match it", () => {
    const result = coverageScore(
      crumbs("Law 10 › 3. Penalties (penalty shoot-out)", "Law 10 › 3. Penalties (penalty shoot-out)"),
      ["Law 10 › 3"],
    );
    expect(result).toEqual({ coverage: 1, missed: [] });
  });

  it("uses segment-aware matching, not raw prefixes", () => {
    // "Law 1" must not be satisfied by a Law 11 chunk (matchesExpected semantics)
    const result = coverageScore(crumbs("Law 11 › 1. Offside position"), ["Law 1"]);
    expect(result).toEqual({ coverage: 0, missed: ["Law 1"] });
  });

  it("returns full coverage vacuously for an empty required list", () => {
    expect(coverageScore(crumbs("Law 9 › 1. Ball out of play"), [])).toEqual({
      coverage: 1,
      missed: [],
    });
  });

  it("misses everything when there are no chunks", () => {
    expect(coverageScore([], ["Law 3 › 1"])).toEqual({ coverage: 0, missed: ["Law 3 › 1"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/evals.test.ts`
Expected: FAIL — `coverageScore` is not exported.

- [ ] **Step 3: Implement**

In `evals/run-evals.ts`, directly after `scoreQuestion` (after line 22):

```ts
// AND-semantics counterpart to scoreQuestion (which is OR: any expected
// section counts). A compound question is fully answerable only if EVERY
// required section has at least one chunk in the top-k. Spec:
// docs/superpowers/specs/2026-07-14-compound-question-eval-design.md §4.
export function coverageScore(
  chunks: { breadcrumb: string }[],
  required: string[],
): { coverage: number; missed: string[] } {
  const missed = required.filter(
    (r) => !chunks.some((c) => matchesExpected(c.breadcrumb, r)),
  );
  return {
    coverage: required.length === 0 ? 1 : (required.length - missed.length) / required.length,
    missed,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/evals.test.ts`
Expected: PASS (all existing + 6 new).

- [ ] **Step 5: Full check + commit**

```bash
npm test && npx tsc --noEmit && npm run lint
git add evals/run-evals.ts tests/evals.test.ts
git commit -m "feat(evals): add AND-semantics coverageScore for compound questions"
```

---

### Task 2: Compound questions file + tier wiring with multi-k diagnostic [Standard tier]

**Files:**
- Create: `evals/compound-questions.json`
- Modify: `evals/run-evals.ts` (`main()`, currently lines 75–108; add one interface near `Golden`, one function after `runGoldenSet`, one call in `main()`)

**Interfaces:**
- Consumes: `coverageScore` (Task 1, exact signature above); `searchWithRetry(question: string, k: number)` (already in the file).
- Produces: console output only — the tier is informational. No exports consumed by later tasks.

- [ ] **Step 1: Create `evals/compound-questions.json`**

The 9 drafted questions. Every `required` entry is a real corpus breadcrumb prefix (verified against the live `chunks` table, 2026-07-14). **These labels are DRAFTS until Markus approves them in Task 3 — do not run the baseline from this task.**

```json
[
  {
    "question": "What happens if everyone on a team gets a red card?",
    "required": ["Law 3 › 1", "Law 7 › 5", "Law 10 › 2", "Law 10 › 3"],
    "note": "The known Part 2b failure: fewer-than-7 abandonment vs penalty-shoot-out confusion. Full answer needs minimum players, abandoned-match consequence, how winners are determined, and when shoot-outs apply."
  },
  {
    "question": "Can a team keep playing if their goalkeeper is sent off and they have no substitutes left?",
    "required": ["Law 3 › 1", "Law 3 › 4"],
    "note": "Needs the minimum-players rule AND the outfield-player-becomes-goalkeeper procedure."
  },
  {
    "question": "A defender deliberately punches the ball off the goal line to stop a goal — what happens?",
    "required": ["Law 12 › 1", "Law 12 › 4"],
    "note": "Handball direct-free-kick/penalty offence plus the DOGSO sending-off — two sections of Law 12 that retrieval must assemble together."
  },
  {
    "question": "A substitute runs onto the pitch and the ball still ends up in the goal — does the goal count?",
    "required": ["Law 3 › 7", "Law 3 › 9"],
    "note": "Extra-person interference rules plus the goal-scored-with-extra-person outcomes table."
  },
  {
    "question": "A penalty kick is awarded in the final seconds of the half — can it still be taken, and can anyone score from the rebound?",
    "required": ["Law 7 › 4", "Law 14 › 1"],
    "note": "Time extension for a penalty at the end of a half (Law 7) plus the kick-completion rule (Law 14) that kills the rebound."
  },
  {
    "question": "The ball bursts as it flies toward the goal and still crosses the line — is it a goal and how does play restart?",
    "required": ["Law 2 › 2", "Law 10 › 1"],
    "note": "Defective-ball replacement/restart plus the definition of a valid goal."
  },
  {
    "question": "During a penalty shoot-out, can an injured goalkeeper be replaced, and by whom?",
    "required": ["Law 10 › 3", "Law 3 › 2"],
    "note": "Shoot-out eligibility rules reference the substitution allowance from Law 3."
  },
  {
    "question": "A defender fouls an attacker who was standing in an offside position but had not yet touched the ball — what does the referee award?",
    "required": ["Law 11 › 2", "Law 12 › 1"],
    "note": "Whether an offside offence has even occurred (involvement) vs the foul — the ruling needs both laws."
  },
  {
    "question": "Can a team make an extra substitution in extra time of a cup match, and what is the procedure for making it?",
    "required": ["Law 3 › 2", "Law 3 › 3"],
    "note": "Additional-substitution allowance plus the substitution procedure itself."
  }
]
```

- [ ] **Step 2: Add the tier to `evals/run-evals.ts`**

Near the `Golden` interface (after line 7), add:

```ts
interface CompoundQuestion {
  question: string;
  required: string[];
  note?: string;
}

// Production uses k=8; the higher ks are an eval-side diagnostic that feeds
// the spec §5 decision rule ("would a bigger k fix compound coverage?").
// Separate retrieval calls per k on purpose — RRF ranking is not guaranteed
// prefix-stable across match_count values.
const COMPOUND_KS = [8, 12, 16, 24];
```

After `runGoldenSet` (after line 73), add:

```ts
async function runCompoundSet(compounds: CompoundQuestion[]): Promise<void> {
  const perK = new Map<number, { full: number; coverageSum: number }>(
    COMPOUND_KS.map((k): [number, { full: number; coverageSum: number }] => [
      k,
      { full: 0, coverageSum: 0 },
    ]),
  );
  for (const c of compounds) {
    const cells: string[] = [];
    let missedAtProductionK: string[] = [];
    for (const k of COMPOUND_KS) {
      const result = await searchWithRetry(c.question, k);
      const { coverage, missed } = coverageScore(result.chunks, c.required);
      const agg = perK.get(k)!;
      agg.coverageSum += coverage;
      if (missed.length === 0) agg.full += 1;
      if (k === 8) missedAtProductionK = missed;
      cells.push(`k=${k} ${c.required.length - missed.length}/${c.required.length}`);
    }
    console.log(`${cells.join("  ")}  ${c.question}`);
    if (missedAtProductionK.length > 0) {
      console.log(`  missed@8: ${missedAtProductionK.join(" | ")}`);
    }
  }
  console.log(`\n[compound] per-k summary (n=${compounds.length}):`);
  for (const k of COMPOUND_KS) {
    const { full, coverageSum } = perK.get(k)!;
    console.log(
      `  k=${k}: full coverage ${full}/${compounds.length}` +
        `  mean coverage ${(coverageSum / compounds.length).toFixed(2)}`,
    );
  }
}
```

In `main()`, load the file alongside the others (after the `abstains` load, line 82):

```ts
  const compounds: CompoundQuestion[] = JSON.parse(
    await readFile("evals/compound-questions.json", "utf8"),
  );
```

And after the abstain-set block (after line 96), before the gate-calibration block:

```ts
  console.log("\n=== Compound set (informational — multi-section AND-coverage per k) ===");
  await runCompoundSet(compounds);
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all green (no new unit tests here — `runCompoundSet` is console wiring over the Task 1 pure function, same untested-by-design status as `runGoldenSet`).

**Do NOT run `npm run eval` in this task** — the baseline is gated behind Markus's approval (Task 3).

- [ ] **Step 4: Commit**

```bash
git add evals/compound-questions.json evals/run-evals.ts
git commit -m "feat(evals): compound-question tier with multi-k coverage diagnostic"
```

---

### Task 3: Markus gate → baseline run → record everywhere [Standard tier; contains a hard STOP]

**Files:**
- Modify: `evals/compound-questions.json` (only if Markus's review changes labels)
- Modify: `docs/superpowers/specs/2026-07-14-compound-question-eval-design.md` (baseline section + revision row)
- Modify: `docs/project-reviewer.md` (measured numbers into the existing compound-limitation bullet in "Bugs & Lessons")
- Modify: `README.md` (Known limitations section)

**Interfaces:**
- Consumes: the Task 2 tier output of `npm run eval`.
- Produces: recorded baseline numbers (documentation only).

- [ ] **Step 1: HARD STOP — Markus reviews the question batch**

Present `evals/compound-questions.json` to Markus in full (questions, `required` labels, notes) and ask for explicit approval of its football correctness. Precedent: his golden-set review caught a real labeling error. **Do not proceed until he approves.** If he changes anything, edit the JSON, re-run `npm test`, and commit:

```bash
git add evals/compound-questions.json
git commit -m "fix(evals): apply Markus's football-correctness review to compound questions"
```

- [ ] **Step 2: Run the baseline**

Run: `npm run eval`
Expected: golden 30/30 (MRR 0.859) and paraphrase 10/10 (MRR 0.863) **unchanged** — if either moved, STOP and investigate before recording anything (this plan must not affect them). Then the compound tier prints per-question k-cells and the per-k summary. Duration ~30 minutes on the Voyage free tier; the 429 backoff messages are normal.

- [ ] **Step 3: Record the baseline in the spec**

In `docs/superpowers/specs/2026-07-14-compound-question-eval-design.md`, insert before the `## Revision history` heading:

```markdown
## Baseline (measured YYYY-MM-DD, 118-chunk corpus, corpus_version 2025-26)

| k | Full coverage | Mean coverage |
|---|---|---|
| 8 (production) | <from run output> | <from run output> |
| 12 | <from run output> | <from run output> |
| 16 | <from run output> | <from run output> |
| 24 | <from run output> | <from run output> |

Per-question detail lives in the eval output; questions missing sections at
k=8: <list question + missed sections from the run's missed@8 lines>.
Decision-rule reading (§5): <one sentence stating which row of the §5 table
the numbers land in>.
```

Fill every `<...>` from the actual run output — committing this section with a placeholder is a task failure. Add a revision-history row: `| YYYY-MM-DD | Baseline recorded (post Markus review of the question batch). |`

- [ ] **Step 4: Record in the interview guide and README**

In `docs/project-reviewer.md`, find the "Bugs & Lessons" bullet beginning **"A known retrieval limitation was documented instead of reactively patched."** and append to it (same bullet, final sentence):

```markdown
Baseline measured YYYY-MM-DD: full coverage <X>/9 at k=8, <X>/9 at k=24 — see the spec's baseline table for the per-k detail and the decision-rule reading.
```

In `README.md`, insert between the "How it works" section and the "Development" section:

```markdown
## Known limitations

- Compound questions spanning several laws at once (e.g. "what happens if
  everyone gets a red card?") can exceed what single-pass k=8 retrieval
  covers: answers cite accurately what was retrieved but may not assemble
  every relevant law. Measured honestly by the eval harness's compound tier
  (`npm run eval`); design + baseline:
  `docs/superpowers/specs/2026-07-14-compound-question-eval-design.md`.
```

- [ ] **Step 5: Full check + commit**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
git add docs/superpowers/specs/2026-07-14-compound-question-eval-design.md docs/project-reviewer.md README.md
git commit -m "docs(evals): record compound-tier baseline and known-limitation note"
```

---

### Finishing the branch

Standard tier: per-task two-stage reviews already ran (SDD); dispatch the final whole-branch `reviewer` agent, then invoke `pre-pr-review`, then open the PR (body must state that golden/paraphrase results are unchanged and quote the compound baseline table). **Do not merge — leave the PR for Markus.**
