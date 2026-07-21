# Generation Grounding Gap Fix — Design Spec

**Date:** 2026-07-20 · **Status:** Approved (Markus, 2026-07-20, in-session)
**Scope decision:** temperature + prompt fix, plus a new generation-level
verification harness (completeness check automated, hedging check
manual-review). No semantic LLM-judge, no change to retrieval. Traces to
issue #65 (filed 2026-07-19, query-decomposition Step 7 click-test — the
same discovery session as issue #64's retrieval gap).

## 1. Problem

For the question "If a player shoots a shot and it bounces off the arm of
an opponent, but eventually gets a goal — should the goal be disallowed and
be considered a penalty or should the goal count?", two independent runs of
the same pipeline against the same corpus produced materially different
answers:

- **Run 1 (correct):** hedged honestly — "I cannot find enough information
  in the Laws of the Game excerpts provided to answer your question with
  certainty..."
- **Run 2 (incorrect):** confidently asserted a specific, unsupported
  ruling — that the goal would be disallowed and a free kick/penalty
  awarded, misapplying the self-scoring handball rule (Law 12 § 1, which
  governs a player's *own* hand/arm) to an opponent's-arm deflection
  scenario the retrieved text never actually addresses.

This is a **generation-side grounding problem**, not a retrieval problem:
the retrieved chunks were topically relevant (real handball rules) but
described a different scenario than the one asked, and the model
sometimes filled the gap with a plausible-sounding but ungrounded
inference instead of recognizing the mismatch and hedging — as it
correctly did on the first run, with identical retrieved context.

## 2. Root cause

Two layers:

1. **Immediate cause (Run 2's specific error):** the retrieved Law 12 § 1
   text governs a player scoring off their *own* hand/arm. It says nothing
   about a defender's/opponent's arm deflecting the ball into the goal.
   Run 2 applied the self-scoring restriction to the opponent's-arm
   scenario anyway.
2. **Mechanism enabling the nondeterminism:** `lib/answer.ts`'s
   `streamAnswer()` does not set a `temperature` parameter on the
   `client.messages.stream()` call, so it uses the Anthropic API default
   of **1.0** — the most variable setting available. The system prompt
   already instructs the model to hedge when unsure (`SYSTEM_PROMPT`,
   `lib/answer.ts`), and Run 1 proves that instruction *can* produce the
   correct behavior given this exact input. Run 2's failure means the
   honest hedge is a high-probability completion, not the only one — at
   temperature 1.0 there's room for a lower-probability, more "confident"
   completion to occasionally get sampled instead. This is the direct
   target of the fix: removing that room, not just reinforcing the
   instruction that already sometimes works.

## 3. Goals / Non-goals

**Goals**
1. Make the correct (hedge-when-scenario-mismatched) behavior the reliable
   outcome, not one of two possible outcomes for the same input.
2. Add generation-level verification that does not exist today — the
   current eval suite (`evals/run-evals.ts`) tests retrieval recall only;
   it never calls the generation model and has zero visibility into what
   a generated answer actually says or cites.
3. Validate the fix doesn't regress existing generation behavior —
   multi-citation completeness on compound questions, correctness on
   single-fact questions.

**Non-goals (explicitly out of scope)**
- A full semantic LLM-judge that checks whether every claim in a generated
  answer is entailed by its cited passage. Real, valuable future work —
  filed as a candidate follow-up issue, not built here. This fix's
  completeness check (§4.2.4) is a cheaper, objective proxy for part of
  what a judge would catch; it does not replace one.
- Testing the abstain (off-topic) question set at the generation layer.
  Those questions are handled upstream by `RELEVANCE_THRESHOLD` in
  production — generation is never reached for them, so exercising them
  through the generation harness would not reflect real behavior.
- Any change to retrieval: `match_chunks`, `RELEVANCE_THRESHOLD`, the
  hybrid vector+keyword fusion logic, or the citations-as-structured-data
  mechanism itself (already a safeguard; not the source of this bug) —
  all untouched.
- A self-consistency / claim-verification second-pass call (see §4.1) —
  considered, not built in this iteration.

## 4. Design

### 4.1 Rejected approaches

- **Prompt hardening alone.** Cheap, but relies entirely on the model
  reliably following stricter wording — exactly the class of thing that
  already failed nondeterministically once (the current prompt already
  says "do not guess," and Run 2 guessed anyway). Insufficient alone;
  combined with a mechanical temperature change instead of standing in
  for one.
- **Self-consistency / claim-verification pass** — a second LLM call
  that checks each claim in the draft answer against its cited passage
  before the answer ships. More robust against fabrication than
  temperature alone (it doesn't just reduce the *chance* of a bad
  completion, it could catch one after the fact). Rejected for this
  iteration: doubles generation latency and API cost on every question in
  a project that already tracks a spend ceiling as a guardrail, for a P2,
  non-blocking issue. Revisit if temperature + prompt hardening prove
  insufficient in production.
- **Full LLM-judge citation-grounding eval tier**, as originally floated
  in issue #65's "Possible directions." Real future value, but a bigger
  scope than this fix needs: a judge-prompt to design, an ongoing
  per-question judge-call cost, and a less deterministic pass/fail
  signal than the completeness check this spec builds instead. Filed as a
  candidate for a future follow-up issue.

### 4.2 Chosen approach: temperature 0 + hardened prompt + a generation-level verification harness

#### 4.2.1 Generation parameter change

`lib/answer.ts`: add `temperature: 0` to the `client.messages.stream()`
call (currently unset, so it uses the API default of 1.0).

**Why 0, not a low-but-nonzero value:** this app's entire premise is
"answer strictly from retrieved passages, never invent" — there is no
scenario where creative variance in a rules-lookup answer is desirable.
The bug's own evidence supports 0 specifically: the correct hedge already
occurred on Run 1 given this exact input, meaning it is already a
high-probability completion under the current prompt — temperature 0
always selects the single highest-probability completion, which biases
toward the behavior already demonstrated as achievable, not toward some
untested new behavior.

**Known limitation, stated honestly:** temperature 0 is "very likely
consistent," not "provably 100% deterministic" — minor floating-point or
model-serving-level nondeterminism can still exist even at temperature 0.
The fix is expected to make the failure rare to the point of practical
non-occurrence, not to offer a mathematical guarantee. §5's repeated-run
testing is designed to measure this directly rather than assume it.

#### 4.2.2 Prompt hardening

Current instruction (`SYSTEM_PROMPT`, `lib/answer.ts`):

> "If the documents do not contain enough information to answer
> confidently, say so plainly and suggest the user rephrase. Do not
> guess."

Replace with a version that names the specific failure mode this issue
found — matching general topic but not matching scenario:

> "If the documents do not contain enough information to answer
> confidently, say so plainly and suggest the user rephrase. Do not
> guess. Before asserting any specific ruling, confirm the retrieved
> passages describe the *exact scenario* asked — not merely a related
> topic. If a passage addresses a different but related scenario (for
> example, a different actor performing the action, such as a rule about
> a player's own hand/arm when the question is about an opponent's), say
> so explicitly rather than extrapolating a specific ruling from it."

Kept as a single expanded bullet (matching the existing prompt's bullet
style) rather than a new separate rule, since it's a refinement of the
existing "do not guess" instruction, not a new category of rule.

#### 4.2.3 Generation-level verification harness (new)

A new capability in `evals/`: a function that, given a question and an
optional temperature override, runs the real retrieval step
(`lib/retrieval.ts`) and the real generation step (`lib/answer.ts`'s
`streamAnswer`), and returns the full answer text plus which chunk
breadcrumbs were actually **cited** in the generated answer — derived from
`citedDocumentIndexes`, mapped back through the same `chunks` array order
used to build `documentBlocks`. This is new: nothing in the eval suite
calls generation today, so there is currently zero automated visibility
into what a generated answer says or cites, only into what retrieval
surfaces.

#### 4.2.4 Completeness check (automated)

For every `compound-questions.json` entry (the existing 14, plus the new
ones from §4.2.6), run it through the harness at temperature 0 and check
that every breadcrumb in that entry's `required: [...]` was actually
**cited in the generated answer** — not merely present in the retrieved
set, which is all today's compound-tier check verifies. Reported as
hit/miss per question, the same style the retrieval-tier output already
uses, added as a new section in `run-evals.ts`'s output. This is an
objective, deterministic-at-fixed-temperature comparison — no judgment
call, no semantic scoring.

Golden (32) and paraphrase (10) questions also run through the harness
once at temperature 0, checking their single `expected` breadcrumb is
still cited. Lower-value individually (a single-citation miss is a
narrower failure than a multi-citation one) but cheap to include and
catches generation-layer regressions (refusals, degenerate output) that
the existing retrieval-only checks structurally cannot see.

#### 4.2.5 Hedging check (manual-review, new)

A new question file, `evals/hedge-questions.json`, containing questions
shaped like this bug — retrieved context that is topically relevant but
scenario-mismatched — including the original reproduction question from
issue #65 verbatim. Each runs through the harness at temperature 0; the
full generated answer text is captured for a human (or an agent reading
against a fixed rubric) to judge: did it hedge appropriately, or did it
assert a specific ruling not stated in the retrieved passages? This is
**not** machine-scored — see §3's non-goals for why a semantic judge is
out of scope here. The manual rubric is binary: hedge = pass, unsupported
specific ruling = fail.

#### 4.2.6 New test questions

- A small number of new `compound-questions.json`-style entries, authored
  to require citing 2+ references, extending completeness-check coverage
  (§4.2.4) beyond the existing 14.
- `evals/hedge-questions.json`, seeded with the original bug's exact
  reproduction question, plus a small number of new scenario-mismatch
  questions in the same shape (topically-adjacent retrieval, no passage
  covering the exact scenario asked).

#### 4.2.7 Temperature comparison during testing

The harness accepts an optional temperature override so the same question
sets (particularly the new hedge set) can be run at temperature 0 versus
the current baseline of 1.0, to empirically compare hedging consistency
and completeness rather than relying on the theoretical argument in
§4.2.1 alone.

## 5. Testing / Success Criteria

- **Golden + paraphrase (42 total):** 100% still cite their single
  required breadcrumb at temperature 0; no refusals or degenerate output.
- **Compound (14 existing + new):** completeness check pass rate at
  temperature 0 reported and compared against the existing retrieval-only
  baseline; any regression investigated before this is considered
  shippable.
- **Hedge set (new, including the original bug question):** each question
  run multiple times (5x, mirroring the reproducibility bar issue #64
  used for its own root-cause confirmation) at temperature 0, manually
  reviewed for consistent hedging. Also run once at temperature 1.0 (the
  current baseline) for direct before/after comparison, recorded in this
  spec's revision history once measured.

## 6. Open questions / risks

- The hedging check is manual-review, not an automated CI gate — it
  relies on a human or agent applying the rubric at verification time and
  will not automatically catch future regressions the way the retrieval
  and completeness checks do. Accepted for this iteration given issue
  #65's P2 priority; revisit if this class of bug recurs.
- Temperature 0 is expected to make the observed failure rare, not
  impossible (§4.2.1) — §5's repeated-run testing measures the actual
  improvement rather than assuming a guarantee.
- **`temperature` is a deprecated parameter for newer model generations.**
  The installed SDK (`@anthropic-ai/sdk@0.110.0`) documents that "Models
  released after Claude Opus 4.6 do not support setting temperature. A
  value of 1.0 will be accepted for backwards compatibility, all other
  values will be rejected with a 400 error." Verified empirically against
  the live API (2026-07-20): `temperature: 0` succeeds against
  `claude-haiku-4-5`, this app's actual model — the deprecation does not
  bite today. But `ANSWER_MODEL` in `lib/answer.ts` is deliberately
  env-swappable ("one line to trade up to Sonnet/Opus," per its own code
  comment) — if `ANTHROPIC_MODEL` is ever pointed at a model released
  after the deprecation cutoff, `temperature: 0` would start being
  silently coerced to 1.0 or rejected outright with a 400, defeating this
  entire fix without any code change to flag it. The implementation plan
  should add a guard or at least a code comment at the `temperature: 0`
  call site warning future maintainers of this specific model-swap risk.

## Provenance

Filed as issue #65 during the query-decomposition feature's Step 7
human end-to-end click-test (2026-07-19), the same session that surfaced
the companion retrieval-gap issue #64. Design decided in-session with
Markus, 2026-07-20 — key scope calls made during that conversation:
temperature 0 over a low-nonzero value (grounded in a category-by-category
read of all four existing eval sets, confirming none of them are
creativity-dependent tasks); the completeness check and hedging check
addressed together rather than separately, since a single global
temperature change needs validation across both failure modes it could
affect; and the hedging check scoped to manual-review rather than an
automated semantic judge, to keep this fix's blast radius contained
without leaving the exact failure this issue reports unverified.

## Revision history

| Date | Change |
|---|---|
| 2026-07-20 | Initial spec — approved in-session after iterative scoping discussion (temperature value, completeness vs. hedging check split, manual-review boundary for the hedging check). |
