# Citation Completeness Gap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #75 (generated answers can drop a required citation even
when every source was retrieved) with a prompt-hardening change plus a new,
permanent eval gate that measures whether the fix actually holds — and stop
at a clear decision point rather than iterating prompt wording ad hoc.

**Architecture:** Two independent, additive changes: (1) a new trailing
"Completeness" section appended to `SYSTEM_PROMPT` in `lib/answer.ts`; (2) a
new async filter + a new `--generation`-mode section in `evals/run-evals.ts`
that isolates the generation-completeness signal from the separate,
already-known retrieval-depth limitation, and threads the existing
`--repeat` flag through it. A third task runs the live verification and
records the escalation decision from the spec.

**Tech Stack:** TypeScript, Vitest, the Anthropic SDK (`@anthropic-ai/sdk`),
Voyage AI embeddings — same stack as the rest of this project, no new
dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-citation-completeness-gap-design.md`
  — every task's requirements implicitly include this spec.
- **Standard risk tier** (generation/eval logic, no auth/RLS/API-contract
  surface — matches issue #65's own tiering per this project's CLAUDE.md).
- No new files: both changes are edits to existing files
  (`lib/answer.ts`, `evals/run-evals.ts`).
- **No new unit tests**: the fix reuses `coverageScore`, already covered by
  `tests/evals.test.ts` (spec §5). The new orchestration functions in
  `evals/run-evals.ts` follow that file's existing convention — async
  functions that call the live retrieval/generation APIs are exercised via
  real eval runs, not unit tests (see `runCompoundSet`,
  `runGenerationCompoundSet`, `runHedgeSet` — none of those are unit
  tested either).
- Existing test suites (`tests/answer.test.ts`, `tests/evals.test.ts`) must
  stay green after every task — run them as a regression check, don't
  assume.
- `npx tsc --noEmit` must stay clean after every task.
- Commit messages follow `C:\Users\Miko\.claude\standards\git-commit-standard.md`.

---

### Task 1: Prompt hardening — add the Completeness section to `SYSTEM_PROMPT`

**Files:**
- Modify: `lib/answer.ts:48-61` (the `SYSTEM_PROMPT` constant)

**Interfaces:**
- Consumes: nothing new — `SYSTEM_PROMPT` is an existing exported `const`.
- Produces: `SYSTEM_PROMPT` (same export, extended value) — Task 2 does not
  depend on this task's output; the two tasks are independent and can be
  done in either order, but are numbered this way to match the spec.

- [ ] **Step 1: Confirm no existing test asserts the exact `SYSTEM_PROMPT` string**

Run: `grep -n "SYSTEM_PROMPT" tests/answer.test.ts`
Expected: no output (already confirmed during planning — this step is a
guard against drift between planning and execution, not a new discovery).
If this unexpectedly finds a match, stop and re-read that test before
proceeding — it means an assumption behind "no new test needed" changed.

- [ ] **Step 2: Edit `SYSTEM_PROMPT` in `lib/answer.ts`**

Current end of the constant (`lib/answer.ts:57-61`):

```ts
Handball and goals — read carefully before answering any question where a goal is scored and the ball touched a hand or arm:
The Laws of the Game only disallow a goal for handball when the player who SCORES is the same player whose hand/arm the ball touched (scoring "directly from" or "immediately after" a touch of their OWN hand/arm). Where the Laws say the ball "touched their hand/arm", "their" means the scorer's own hand/arm.
Before ruling, work out two things: who scored, and whose hand/arm the ball touched.
- If they are the SAME player, the goal is disallowed.
- If they are DIFFERENT players (for example the ball deflected off an opponent's, a defender's, or a team-mate's hand/arm before a different player scored), the Laws of the Game do NOT give a ruling for that situation. In that case you must NOT say the goal is disallowed, does not count, or is a handball offence. Instead, say plainly that the Laws of the Game do not specify a ruling for that exact situation and suggest the user rephrase or check with a match official.`;
```

Replace the closing backtick-and-semicolon with a new trailing section
first, so the full constant becomes:

```ts
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
```

Use the Edit tool with `old_string` set to the exact current closing lines
(from `Handball and goals` through the final backtick-semicolon shown in
the "Current end" block above) and `new_string` set to the same text plus
the new `Completeness` paragraph, ending in the backtick-semicolon shown
above. Do not touch anything before the `Handball and goals` section.

- [ ] **Step 3: Run the existing answer-logic test suite**

Run: `npx vitest run tests/answer.test.ts`
Expected: PASS, same pass count as before this change (no test asserts
`SYSTEM_PROMPT` content, so this confirms the edit didn't break
`documentBlocks`, `citedBreadcrumbs`, `warnIfTemperatureUnsafe`, or
`streamAnswer`'s own logic, which is unrelated to the prompt string).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/answer.ts
git commit -m "$(cat <<'EOF'
feat: add completeness instruction to answer system prompt (issue #75)

Generated answers sometimes omit a required citation on compound
questions even when retrieval delivered every source. Adds a
dedicated trailing prompt section (same structural pattern as the
existing handball section) instructing the model to address every
relevant provided document, not just the most salient one.
EOF
)"
```

---

### Task 2: Eval harness — retrieval-complete filter + escalation-bar check

**Files:**
- Modify: `evals/run-evals.ts` (add two new functions after the existing
  `runGenerationCompoundSet`, around line 234; wire one of them into the
  `--generation` branch of `main()`, around line 297-299)

**Interfaces:**
- Consumes: `CompoundQuestion` (existing interface, `evals/run-evals.ts:24-28`),
  `coverageScore` (existing exported function, `evals/run-evals.ts:55-64`),
  `searchChunks` (existing import from `../lib/retrieval`),
  `withVoyageRetry` (existing import from `./voyage-retry`),
  `runGeneration` (existing import from `./generation-harness`).
- Produces: two new, non-exported functions —
  `retrievalCompleteCompounds(compounds: CompoundQuestion[]): Promise<CompoundQuestion[]>`
  and
  `runGenerationCompoundSetFiltered(compounds: CompoundQuestion[], temperature: number, repeat: number): Promise<void>`.
  Neither is exported or consumed by a later task — this task is
  self-contained.

- [ ] **Step 1: Add the two new functions to `evals/run-evals.ts`**

Insert immediately after the existing `runGenerationCompoundSet` function
(ends at `evals/run-evals.ts:234` with the closing `}`), before
`runHedgeSet`:

```ts
// Returns only the compound questions whose retrieval at k=8 already
// achieves full required-section coverage — isolates the generation-
// completeness signal (issue #75) from the separate, already-known
// retrieval-depth limitation (some compound questions never reach full
// retrieval coverage at k=8, which is a different problem this eval
// section doesn't test). Computed fresh each run, not a hardcoded list,
// so the filter doesn't go stale if retrieval changes later.
async function retrievalCompleteCompounds(
  compounds: CompoundQuestion[],
): Promise<CompoundQuestion[]> {
  const complete: CompoundQuestion[] = [];
  for (const c of compounds) {
    const { chunks } = await withVoyageRetry(() => searchChunks(c.question, 8));
    if (coverageScore(chunks, c.required).missed.length === 0) complete.push(c);
  }
  return complete;
}

// The decision-gating check for issue #75: on the retrieval-complete
// subset above, does generation cite every required section on EVERY
// repeat, not just one lucky pass? See
// docs/superpowers/specs/2026-07-22-citation-completeness-gap-design.md
// §4.2.5 for what to do with the result.
async function runGenerationCompoundSetFiltered(
  compounds: CompoundQuestion[],
  temperature: number,
  repeat: number,
): Promise<void> {
  const filtered = await retrievalCompleteCompounds(compounds);
  console.log(
    `\n[compound — retrieval-complete subset] ${filtered.length}/${compounds.length} ` +
      `questions have full retrieval coverage at k=8; only these are scored below.`,
  );
  if (filtered.length === 0) {
    console.log(
      `\n[compound — retrieval-complete subset, escalation-bar check] INCONCLUSIVE: ` +
        `no compound questions have full retrieval coverage at k=8 — this indicates a ` +
        `retrieval regression, not a generation-completeness result. Investigate ` +
        `retrieval before treating this as a pass.`,
    );
    return;
  }
  let fullOnEveryRepeat = 0;
  let totalRuns = 0;
  let totalFull = 0;
  for (const c of filtered) {
    let fullCount = 0;
    for (let i = 1; i <= repeat; i++) {
      const { citedBreadcrumbs } = await runGeneration(c.question, 8, temperature);
      const { missed } = coverageScore(
        citedBreadcrumbs.map((breadcrumb) => ({ breadcrumb })),
        c.required,
      );
      if (missed.length === 0) fullCount += 1;
      console.log(
        `  run ${i}/${repeat}: ${missed.length === 0 ? "FULL " : "MISS "} ` +
          `${c.required.length - missed.length}/${c.required.length}  ${c.question}`,
      );
      if (missed.length > 0) console.log(`    not cited: ${missed.join(" | ")}`);
    }
    if (fullCount === repeat) fullOnEveryRepeat += 1;
    totalRuns += repeat;
    totalFull += fullCount;
  }
  console.log(
    `\n[compound — retrieval-complete subset, escalation-bar check, ` +
      `temperature=${temperature}, repeat=${repeat}] full on every repeat: ` +
      `${fullOnEveryRepeat}/${filtered.length}  ` +
      `(aggregate pass rate across all runs: ${totalFull}/${totalRuns})`,
  );
}
```

**Second fix applied after PR #85's second review round (fresh Opus retry,
2026-07-22):** added `totalRuns`/`totalFull` aggregate tracking above —
the original strict `fullOnEveryRepeat` count is all-or-nothing per
question, so a fix that helps substantially but doesn't reach 100%
consistency on every single question would look identical to zero
improvement. The aggregate pass-rate line gives spec §4.2.5's escalation
decision a gradient to read alongside the strict bar, not just a binary.
Two more findings from that same round, noted but not changed: the new
Completeness prompt section's "provided document" wording sits in mild
tension with `SYSTEM_PROMPT`'s existing Rule 5 ("don't mention 'the
documents'") — accepted as consistent with how Rules 1-2 already use
"documents" as instruction-level vocabulary without it leaking into
answers, not a new risk this fix introduces; and a NIT correcting the
prior round's "byte-identical" claim about the two doc-comments (the
executable code matches exactly, the comments had one small wording
difference, since synced).

**Third fix applied during Task 2's implementation (2026-07-23):** this
paragraph itself was sitting inside the unclosed code fence above until
the implementer flagged it as a concern — the closing ` ``` ` had been
left after this prose instead of right after the function's closing
brace. Moved the fence to close immediately after the code; no code
content changed, markdown-authoring fix only.

**Fix applied after PR #85 review (fresh Opus dispatch, 2026-07-22):** the
`if (filtered.length === 0)` early return above wasn't in the originally
approved plan — added because the escalation bar's `X === N` check
(Task 3 Step 3) would otherwise pass vacuously on a `0/0` result. See the
spec's §4.2.5 revision-history entry for the full finding. The reviewer
also flagged that this function's retrieval (via `retrievalCompleteCompounds`
above) plus `runGeneration`'s own internal retrieval means `repeat + 1`
Voyage calls per filtered question — accepted as consistent with this
file's existing patterns and negligible cost (Voyage-only), not changed.

- [ ] **Step 2: Wire the new section into `main()`'s `--generation` branch**

Current code (`evals/run-evals.ts`, inside the `if (process.argv.includes("--generation"))` block):

```ts
    console.log("\n=== Compound set — generation completeness (AND-semantics) ===");
    await runGenerationCompoundSet(compounds, temperature);

    console.log("\n=== Hedge set — MANUAL REVIEW REQUIRED (not automated pass/fail) ===");
    await runHedgeSet(hedges, temperature, repeat);
    return;
```

Replace with (inserting the new section between the two existing ones):

```ts
    console.log("\n=== Compound set — generation completeness (AND-semantics) ===");
    await runGenerationCompoundSet(compounds, temperature);

    console.log("\n=== Compound set — generation completeness, retrieval-complete subset (escalation-bar check) ===");
    await runGenerationCompoundSetFiltered(compounds, temperature, repeat);

    console.log("\n=== Hedge set — MANUAL REVIEW REQUIRED (not automated pass/fail) ===");
    await runHedgeSet(hedges, temperature, repeat);
    return;
```

Note `repeat` is already in scope here (`const repeat = parseRepeatArg(process.argv);`
a few lines earlier in the same branch) — no new variable needed.

- [ ] **Step 3: Run the existing eval-helpers test suite**

Run: `npx vitest run tests/evals.test.ts`
Expected: PASS, same pass count as before (this task adds no new pure
functions and doesn't change `coverageScore`, `matchesExpected`,
`scoreQuestion`, `parseTemperatureArg`, or `parseRepeatArg` — this run
confirms the new code didn't accidentally break an existing export via a
naming collision or a stray edit).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean, no errors. This is the primary correctness signal for
this task before the live verification in Task 3 — `evals/run-evals.ts`
is a script, not covered by the Vitest suite beyond the pure-function
tests above, so a clean type-check confirms the new async functions,
their call sites, and the `main()` wiring all line up correctly.

- [ ] **Step 5: Commit**

```bash
git add evals/run-evals.ts
git commit -m "$(cat <<'EOF'
feat: add retrieval-complete escalation-bar eval gate (issue #75)

Adds a permanent --generation mode check that isolates the
generation-completeness signal from the separate, already-known
retrieval-depth limitation: filters compound questions to the
subset where retrieval already achieves full coverage at k=8
(computed fresh each run, not hardcoded), then runs generation
--repeat times per question and requires full citation coverage
on every repeat, not just one pass.
EOF
)"
```

---

### Task 3: Live verification and escalation decision

**Files:** none modified — this task runs the harness built in Task 2
against the live Supabase/Voyage/Anthropic stack and records the result.

**Interfaces:**
- Consumes: `npm run eval -- --generation --repeat=3` (the CLI entry
  point wired up in Task 2), requires `ANTHROPIC_API_KEY` in `.env.local`
  per this project's existing `--generation` mode convention.
- Produces: a pass/fail read against the escalation bar (spec §4.2.5),
  reported to Markus — not auto-acted-on. This task does not close issue
  #75 or start designing the heavier completeness-check architecture on
  its own; both of those are follow-up actions gated on Markus's
  explicit direction, consistent with how this project has always
  treated escalation/close decisions.

> ⚠️ **Real cost and time, real API calls — confirm with Markus before
> running.** This is roughly 100 paid Anthropic (Haiku 4.5) calls (golden
> 32 + paraphrase 10 + informational compound 16 + filtered subset ~5×3 +
> hedge 9×3 — corrected 2026-07-22, PR #85 review: the original ~200
> estimate double-counted), roughly $0.50-1 CAD, ~5-10 minutes wall-clock.
> Re-confirm with Markus immediately before running rather than assuming
> an earlier discussion is still an active go-ahead. Do not run this step
> unattended as part of an unsupervised task chain.

- [ ] **Step 1: Confirm `ANTHROPIC_API_KEY` is set**

Run: `grep -c ANTHROPIC_API_KEY .env.local`
Expected: `1` (the key is present; this project's `--generation` mode
throws immediately with a clear error if it's missing, but checking first
avoids a wasted partial run through the free-tier retrieval-only sections
that precede the `--generation` branch's own guard).

- [ ] **Step 2: Get Markus's explicit go-ahead, then run the full generation suite**

Run: `npm run eval -- --generation --repeat=3`

This runs, in order: golden (32 questions, 1 pass each), paraphrase (10
questions, 1 pass each), the existing informational compound tier (16
questions, 1 pass each), the new escalation-bar subset from Task 2 (only
the retrieval-complete questions, 3 passes each), and the hedge set (9
questions, 3 passes each — issue #65's regression suite).

Capture the full console output — every task's own eval-run output has
historically been recorded in this project's spec revision history or
journal, not just summarized from memory.

- [ ] **Step 3: Read the results against the spec's success criteria**

From the spec (§5):
- Golden: expect `32/32` cited (unchanged from baseline).
- Paraphrase: expect `10/10` cited (unchanged).
- Compound, full 16 (informational): compare against the last recorded
  baseline in this project's eval history; a difference here is a
  retrieval-side observation, not something this fix targets — note it,
  don't chase it in this task.
- **Escalation-bar check (the decision-gating line):** read the printed
  `full on every repeat: X/N` line from the new section. If `X === N`
  **and `N > 0`** (every question in a non-empty retrieval-complete
  subset achieved full citation coverage on all 3 repeats), the bar is
  met. If the section instead printed `INCONCLUSIVE` (added after PR #85
  review — see Task 2 Step 1), the retrieval-complete subset was empty:
  treat this as a retrieval regression to investigate, not a passing
  result, and do not read it as "bar met."
- Hedge set: manually review each answer against its `[expect: ...]` tag,
  exactly as the existing hedge-set instructions describe — confirm no
  regression from the issue #65 fix (in particular, the same-player
  control entry must still confidently rule, not hedge).

- [ ] **Step 4: Report the escalation decision to Markus — do not act on it unilaterally**

Per spec §4.2.5:
- **If the bar is met:** report this clearly (exact numbers from Step 3),
  and note that per the spec, the heavier post-generation completeness
  check does not need to be built — recommend closing issue #75, but
  leave the actual close action (and its GitHub comment, per this
  project's established issue-close-verification practice) to Markus's
  explicit instruction, not automatic.
- **If the bar is not met:** report exactly which question(s) and which
  repeat(s) missed, and what was cited instead (the console output from
  Step 2 already contains this detail per-line). Present this as an open
  decision for Markus — design the heavier post-generation completeness
  check, or accept the residual gap as a documented limitation — rather
  than iterating the Task 1 prompt wording ad hoc in this same task. This
  mirrors the exact discipline issue #65's own investigation needed
  before it converged (see that issue's spec §4.2.2.2): a partial result
  needs a real decision, not another guess at wording.
