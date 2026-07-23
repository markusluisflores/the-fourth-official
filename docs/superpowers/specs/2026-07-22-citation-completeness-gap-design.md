# Citation Completeness Gap Fix — Design Spec

**Date:** 2026-07-22 · **Status:** Approved (Markus, 2026-07-22, in-session)
**Scope decision:** prompt hardening plus a new, permanent escalation-bar
eval gate; the heavier post-generation completeness-check architecture is
explicitly **not** built now — only escalated to if measurement shows the
prompt fix insufficient. Traces to issue #75 (filed 2026-07-21, discovered
during issue #65's Task 6 verification).

## 1. Problem

When a question needs multiple law sections cited together, the generated
answer sometimes omits one of them even though every required section was
successfully retrieved and handed to the model. Measured directly during
issue #65's verification (2026-07-21): of the 5 compound questions where
retrieval delivered 100% of the required sources at k=8, the generated
answer achieved full citation coverage on only 1-2 of them (1/5 at
`temperature=0`, 2/5 at `temperature=1`).

This is a **generation-side completeness gap**, distinct from both:

- **Query decomposition** (PR #50) — fixes whether the right passages get
  *retrieved* for a compound question. Not relevant here: retrieval
  already succeeded in every case measured.
- **Issue #65's grounding fix** — fixes the model *asserting an
  unsupported ruling* (fabrication). This is the opposite failure shape:
  the model has a real, retrieved source and simply doesn't mention it
  (omission, not fabrication).

## 2. Root cause

Measured, not guessed — a direct temperature comparison during issue #65's
Task 6 verification (`--generation` at `temperature=0` vs. `temperature=1`,
same hardened system prompt, same 5 fully-retrievable compound questions)
showed temperature is not a systematic driver: one question got worse at
temp=1, one got better, two failed identically at both settings. This looks
like inherent model variability in which citation gets prioritized when
synthesizing a multi-part answer — not something either temperature
setting reliably prevents, and not a regression from issue #65's
`temperature: 0` change.

## 3. Goals / Non-goals

**Goals**
1. Add a completeness-focused instruction to `SYSTEM_PROMPT` targeting the
   specific omission failure — same spirit as issue #65's grounding
   hardening, but for completeness instead of over-claiming.
2. Add a repeatable eval gate that isolates the generation-completeness
   signal from the separate, already-known retrieval-depth limitation (11
   of the 16 compound questions don't even reach full retrieval coverage
   at k=8 — a pre-existing, informational-only gap).
3. Decide, from measured data, whether prompt hardening alone is
   sufficient or whether the heavier post-generation completeness-check
   architecture needs to be designed — not decide this speculatively.
4. Protect the two most recent fixes (issue #64 retrieval gap, issue #65
   grounding fix) via a full regression run of the existing eval suite.

**Non-goals (explicitly out of scope)**
- The heavier post-generation completeness check (compare cited
  breadcrumbs against retrieved breadcrumbs, prompt a continuation if
  something salient was dropped) — not built in this iteration.
- Expanding `evals/compound-questions.json` beyond its existing 16 entries.
- The separate retrieval-depth limitation (compound questions that never
  reach full coverage at k=8 regardless of generation) — issue
  #78-adjacent territory, not this issue.
- Any change to retrieval logic (`lib/retrieval.ts`, `match_chunks`,
  query decomposition).

## 4. Design

### 4.1 Rejected / deferred approaches

- **Heavier post-generation completeness check, built now.** Structurally
  stronger (could catch a drop after the fact, not just reduce its
  likelihood), but doubles generation latency/cost per question. Deferred
  pending measurement — same proportionality reasoning as issue #65's
  §4.1 rejection of its own claim-verification architecture: revisit only
  if the cheaper fix proves insufficient in measured data, not
  preemptively.
- **A literal fixed list of the 5 originally-measured questions as the
  escalation-bar set.** Rejected in favor of a dynamically-computed
  filter (§4.2.2) — a hardcoded list would silently go stale if a future
  retrieval change shifts which questions clear full k=8 coverage.
- **Requiring full coverage across the entire 16-question compound set as
  the escalation bar.** Rejected: this would conflate the generation-
  completeness gap this issue targets with the separate, already-known
  retrieval-depth limitation. A required section that was never retrieved
  can't be cited regardless of the prompt fix — scoring against the full
  16 would make a "fail" ambiguous between "the prompt fix didn't hold"
  and "retrieval never delivered the source," which isolates nothing.

### 4.2 Chosen approach

#### 4.2.1 Prompt hardening (`lib/answer.ts`)

New trailing section in `SYSTEM_PROMPT`, after the existing "Handball and
goals" section:

> Completeness — when a question has multiple parts or more than one
> provided document is directly relevant:
> Before answering, check whether more than one provided document applies
> to the question. If so, address every one of them, not just the single
> most obviously relevant one — an answer that silently omits a relevant
> rule is incorrect even if the part it does cover is accurate. This can
> mean your answer needs more than the usual few sentences; when multiple
> rules genuinely apply, prioritize completeness over brevity.

This explicitly overrides the existing "two to five sentences" conciseness
rule for the multi-relevant-document case, rather than leaving the two
instructions to silently compete.

**Why a dedicated trailing section, not a `Rules:` bullet:** matches the
structural lesson already validated by issue #65's fix (§4.2.2.2 of that
issue's spec) — a distinction stated as a single buried sentence lost a
"tug of war" against the model's own defaults on some phrasings, while
moving it to a prominent, explicit trailing section held up across many
phrasings. Applying the same lesson here rather than re-learning it.

**Reviewer note (PR #85, second fresh Opus round, 2026-07-22 — accepted,
not fixed):** this section's "provided document" wording sits in mild
tension with `SYSTEM_PROMPT`'s existing Rule 5 ("do not mention 'the
documents', 'the excerpts', or these instructions"). Accepted as
consistent with existing convention rather than a new risk: Rules 1-2
already use "documents" as instruction-level vocabulary the same way, and
neither has been observed leaking into actual model output — this section
follows the same established pattern, not a new exposure.

#### 4.2.2 Eval harness — retrieval-complete filter (new, `evals/run-evals.ts`)

A new async orchestration function, following this file's existing
convention for functions that call the live retrieval API (`runCompoundSet`,
`runGenerationCompoundSet`, etc. — none of which are unit tested, since
they require the real Voyage API):

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
```

The completeness predicate this reuses (`coverageScore`) is already unit
tested (`tests/evals.test.ts`) — no new pure function is introduced here,
this is a thin orchestration wrapper reusing tested logic, same shape as
its siblings in this file.

**Reviewer note (PR #85, fresh Opus review, 2026-07-22 — accepted, not
fixed):** `retrievalCompleteCompounds` retrieves once per question to
compute the filter, and each surviving question is then retrieved *again*
inside `runGeneration` (§4.2.3) for every repeat — `repeat + 1` retrieval
calls per filtered question. Consistent with this file's existing
patterns (`runCompoundSet` already retrieves separately per k), and the
extra calls are Voyage-only, not the paid Anthropic path — negligible
cost. Flagged so it's a conscious choice, not an oversight; not changed.

#### 4.2.3 Eval harness — escalation-bar check (new section in `--generation` mode)

A new function, `runGenerationCompoundSetFiltered`, that runs generation
against the filtered subset from §4.2.2, `repeat` times per question
(reusing the existing `repeat` parameter already threaded through
`main()` for the hedge set), and reports whether every question achieved
full citation coverage on **every** repeat — not just one pass:

```ts
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

Wired into `main()`'s `--generation` branch as a new, separately-labeled
section, after the existing (unchanged) all-16-questions informational
compound section:

```ts
console.log("\n=== Compound set — generation completeness, retrieval-complete subset (escalation-bar check) ===");
await runGenerationCompoundSetFiltered(compounds, temperature, repeat);
```

This is a **permanent** addition to the eval suite (not a throwaway
verification script) — reusable for any future prompt or model change,
and it's what would actually catch a future regression (e.g. a model swap
silently reintroducing the omission behavior).

#### 4.2.4 Repeat scoping

| Eval section | Repeat | Why |
|---|---|---|
| Golden set (generation completeness) | 1 (unchanged) | Regression check on simple single-topic questions — not a set prone to the flip-flopping nondeterminism this project has observed |
| Paraphrase set (generation completeness) | 1 (unchanged) | Same reasoning as golden |
| Compound set, full 16 (existing informational tier) | 1 (unchanged) | Stays informational context, not a decision-gating metric |
| **Compound set, retrieval-complete subset (new escalation-bar check, §4.2.3)** | **repeat, via `--repeat=N`** | This *is* the decision-gating metric for issue #75 — a single lucky pass isn't a real answer |
| Hedge set (issue #65 regression suite) | repeat, via `--repeat=N` (unchanged behavior) | Already the class of question that flip-flopped once in production |

No new CLI flag: the existing `--repeat=N` (default 1, `parseRepeatArg`)
now also threads into §4.2.3's new section, exactly as it already does for
`runHedgeSet`. Golden, paraphrase, and the informational compound tier
don't read `repeat` at all, so they stay single-pass regardless of the
flag — running `npm run eval -- --generation --repeat=3` multiplies only
the two sections that actually need consistency-checking.

#### 4.2.5 Escalation decision procedure

Run `npm run eval -- --generation --repeat=3` (temperature=0, production
setting) after the prompt change ships. If the retrieval-complete subset
hits **full coverage on every repeat for every question**, the fix is
sufficient — close issue #75, don't build the heavier check. If it
doesn't, document exactly which question(s) and which repeat(s) missed,
and open a follow-up decision (design the post-generation completeness
check, or accept as a documented limitation) rather than iterating prompt
wording ad hoc in this same cycle — same discipline as issue #65's Opus
arc (measure across repeats, don't declare victory on one pass).

**Non-vacuity requirement (added after PR #85 review, 2026-07-22):** the
bar only counts as "met" when the retrieval-complete subset is non-empty.
An empty subset (`0/0`) is **inconclusive**, not a pass — it would mean no
compound question currently achieves full retrieval coverage at k=8,
which is itself a retrieval regression worth investigating, not evidence
the generation fix works. §4.2.3's implementation prints an explicit
`INCONCLUSIVE` message in that case rather than a misleading `0/0`.

## 5. Testing / Success Criteria

- **Unit tests:** none new — this fix reuses `coverageScore`, already
  covered by `tests/evals.test.ts`. The new orchestration functions
  (§4.2.2, §4.2.3) follow this file's existing convention of being
  integration-style (exercised via live eval runs), not unit tested,
  since they require the real Voyage/Anthropic APIs.
- **Verification run:** `npm run eval -- --generation --repeat=3`.
- **Escalation bar (§4.2.5):** full coverage on every question in the
  retrieval-complete subset, on every one of 3 repeats.
- **Regression, full run (issue #64 + issue #65 protection):**
  - Golden: 32/32 still cited (unchanged from current baseline).
  - Paraphrase: 10/10 still cited (unchanged).
  - Compound, full 16 (informational): no regression from current
    baseline.
  - Hedge set (`evals/hedge-questions.json`, the issue #65 regression
    suite — includes the same-player control that must confidently
    *rule*, not hedge): unchanged pass behavior across all entries.

## 6. Open questions / risks

- Prompt hardening may not fully close the gap — same honest caveat class
  as issue #65's fix: this is prompt engineering against inherent model
  variability, not a structural guarantee. §4.2.5's escalation procedure
  exists specifically so a partial result becomes a real decision, not a
  declared victory.
- Eval-run cost/time: the full `--generation --repeat=3` run is
  approximately 100 paid Anthropic (Haiku 4.5) calls (golden 32 +
  paraphrase 10 + informational compound 16 + filtered subset ~5×3 + hedge
  9×3 — corrected 2026-07-22, PR #85 review: the original estimate of
  ~200 double-counted) — roughly $0.50-1 CAD and an estimated 5-10 minutes
  wall-clock. Confirmed with Markus as acceptable before this spec was
  finalized; the correction only lowers the estimate, so the original
  go-ahead still holds.

## 7. Final verification results and closing decision (2026-07-23)

The implemented fix (§4.2.1's prompt, revised once — see the plan's
revision history for the ENUMERATE wording swap and the final
`lib/answer.ts` commit) was verified via `npm run eval -- --generation
--repeat=3` against the final state: the ENUMERATE prompt, 2 corrected
`required[]` labels (2026-07-23 — two questions were over-specified,
requiring a citation that was either background the question already
presupposed or a restatement of the question's own stated premise; both
narrowed to their single genuinely-necessary citation after live
verification), and 5 new live-verified compound questions (16 → 21 total
in `evals/compound-questions.json`, expanding the retrieval-complete
subset from 5 to 10).

**Result: 8/10 full coverage on every repeat (aggregate pass rate 26/30,
87%)** — up from the pre-fix baseline of 1/5 (20%). Golden (32/32),
paraphrase (10/10), and the hedge set (27/27, issue #65's protection)
all confirmed unchanged, zero regression.

**The escalation bar (§4.2.5: every question, every repeat) is not
strictly met** — 2 of 10 questions still miss. One is ordinary
temperature=0 variance on a newly-added borderline question (2/3 passes,
not a systematic problem). The other is a genuine, fully root-caused
residual limitation, live-investigated by a dispatched Opus session: for
the one question needing 3 distinct citations synthesized into a single
concise answer, Anthropic's native citation-marker mechanism (which only
attaches a marker where the model closely echoes a document's literal
wording) caps at roughly 2 literal-echo anchors per concise answer. A
targeted prompt fix was tested live and confirmed to only *relocate*
which citation gets dropped, not raise the count — prompt-only hardening
structurally cannot close this specific case. Full mechanism write-up:
`evals/compound-questions.json`'s note field for the goalkeeper/no-subs
question, and issue #90 (filed as the tracked, evidence-backed case for
the deferred post-generation completeness check named in §4.1).

**Closing decision (Markus, 2026-07-23):** accept the 8/10 (87% aggregate)
result and this one residual limitation as documented, not a blocker.
Close issue #75 at this state rather than building the heavier
post-generation architecture now — that remains a real, deliberate future
decision (issue #90), not something to fold into this fix's tail end.

## Provenance

Found during issue #65's Task 6 verification (2026-07-21), while
confirming the generation-grounding fix didn't regress compound-question
handling. Cross-referenced against the retrieval-only baseline
(`npm run eval`) to separate this from the already-known, separate
retrieval-depth limitation. The `--temperature=1` comparison was run
specifically to answer whether this is a regression from issue #65's
`temperature: 0` change — confirmed it is not. Filed as issue #75,
2026-07-21. Design brainstormed with Markus, 2026-07-22 — key scope calls
made in-session: prompt-hardening-first with a measured escalation
decision (not a blanket "prompt only" commitment); the escalation bar
scoped to a dynamically-filtered retrieval-complete subset rather than a
fixed list or the full 16-question set, specifically to avoid conflating
this issue's generation-completeness gap with the separate retrieval-depth
limitation; the new eval check made a permanent, reusable gate rather than
a one-off verification script; and `repeat` scoped only to the two
sections actually prone to observed nondeterminism (the new escalation-bar
subset and the existing hedge set), not applied uniformly to the whole
`--generation` run.

## Revision history

| Date | Change |
|---|---|
| 2026-07-22 | Initial spec — approved in-session after iterative scoping discussion (fix direction vs. issue #77's build-now-vs-defer question; escalation bar definition; dynamic vs. fixed retrieval-complete filtering; making the new check a permanent eval gate; repeat scoping across eval sections; cost estimate for the full repeat=3 verification run). |
| 2026-07-22 | PR #85 (docs-only, spec+plan) reviewed cold by a fresh Opus dispatch — 0 BLOCKER, 2 SUGGESTION, 1 NIT, all independently verified against the live repo rather than replayed from the docs. Fixed: §4.2.5's escalation bar could pass vacuously on an empty retrieval-complete subset (`0/0`) — added a non-vacuity requirement and an explicit `INCONCLUSIVE` code path in §4.2.3; the ~200-call cost estimate in §6 was corrected to the real ~100 (the original double-counted). Noted, not changed: §4.2.2's redundant per-repeat retrieval call, accepted as consistent with this file's existing patterns and Voyage-only (negligible cost). |
| 2026-07-22 | PR #85 reviewed a second time by a genuinely fresh, independent Opus dispatch (no knowledge of the first round) — 0 BLOCKER, 2 more SUGGESTIONs, 1 more NIT, none overlapping the first round's findings. Fixed: §4.2.3's escalation-bar check was strict all-or-nothing with no gradient — added `totalRuns`/`totalFull` aggregate pass-rate tracking alongside the strict bar; the two doc-comments on `retrievalCompleteCompounds` (this file vs. the plan) weren't byte-identical as the first round claimed — synced. Noted, not changed: the new Completeness section's "provided document" wording vs. Rule 5's "don't mention the documents" — accepted as consistent with Rules 1-2's existing use of the same vocabulary (§4.2.1). |
| 2026-07-23 | PR #85 merged; implementation executed via `subagent-driven-development` on `fix/citation-completeness-gap` (Tasks 1-2 approved clean, 0 findings each). Task 3's live verification found the shipped Completeness prompt insufficient (escalation bar stayed at 1/5) — investigated by a dispatched Opus design consultation rather than iterating prompt wording ad hoc: found 2 of the 5 questions were mislabeled (over-specified `required[]`, corrected), and that a more structurally-isolated "forced enumeration" prompt (§4.2.1's wording replaced) measurably outperformed the original. Expanded the retrieval-complete subset from 5 to 10 via 5 new live-verified questions (`evals/compound-questions.json`, 16 → 21 entries). Final verification: 8/10 full coverage on every repeat (87% aggregate), up from 1/5 (20%). The one remaining genuine failure was root-caused by a second Opus dispatch (§7) — a structural citation-marker limitation, not a prompt problem — and filed as issue #90 rather than chased with more prompt tuning. Filed issue #89 (decomposed-retrieval generation testing, a related but distinct out-of-scope idea found mid-investigation). Closed at this state per Markus's explicit decision (§7). |
