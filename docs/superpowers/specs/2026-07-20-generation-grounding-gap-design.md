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

**Correction (2026-07-21, PR #76 — flagged by fresh Fable review):** this
theory explains the observed *nondeterminism* at temperature 1.0, but
does not fully hold for why temperature 0 alone was insufficient — §4.2.2.1
found that with the *original* prompt wording, the incorrect assertion
was the deterministic top completion at temperature 0 (5/5 failures), not
a rare low-probability sample. The honest hedge was not actually the
higher-probability completion for this specific question under that
wording — see §4.2.2.1 for the real mechanism and the fix that worked.

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

#### 4.2.2 Prompt hardening (revised 2026-07-21 — see §4.2.2.1 for why)

**Original instruction shipped in Task 1** (`SYSTEM_PROMPT`, `lib/answer.ts`),
replacing the prior "do not guess" bullet with a version naming the
specific failure mode this issue found — matching general topic but not
matching scenario:

> "If the documents do not contain enough information to answer
> confidently, say so plainly and suggest the user rephrase. Do not
> guess. Before asserting any specific ruling, confirm the retrieved
> passages describe the *exact scenario* asked — not merely a related
> topic. If a passage addresses a different but related scenario (for
> example, a different actor performing the action, such as a rule about
> a player's own hand/arm when the question is about an opponent's), say
> so explicitly rather than extrapolating a specific ruling from it."

**This did not fix the fix's own primary reproduction question.** Task 6's
live verification (2026-07-21) ran the original bug's exact reproduction
question 5 times at `temperature: 0` with this instruction in place: 5/5
runs confidently asserted "the goal should be disallowed," the exact
unsupported-ruling failure this issue exists to prevent — now happening
*consistently* rather than nondeterministically. See §4.2.2.1 for the
investigation and the replacement instruction that fixed it.

##### 4.2.2.1 Investigation: why the general instruction failed, and what actually worked

**The retrieved passage is not actually ambiguous, once traced carefully.**
The Law 12 § 1 handball text reads: *"It is an offence if a player: ...
scores in the opponents' goal: directly from their hand/arm... immediately
after the ball has touched their hand/arm..."* — "a player" is the single
subject governing the whole bulleted list, so "their hand/arm" clearly
refers to the *same* player who scores, not a different one. A careful
read resolves this cleanly. The original instruction (§4.2.2) already
named almost this exact scenario abstractly ("a different actor
performing the action, such as a rule about a player's own hand/arm when
the question is about an opponent's") — and the model still failed on
precisely this case.

**Making the instruction more explicit and mechanical made it *worse*, not
better.** Tested a stronger variant instructing the model to explicitly
trace which noun each pronoun in a retrieved passage refers back to
before applying any rule — same question, 5 runs at `temperature: 0`.
Result: 5/5 failures, and the model went further than before — it
**paraphrased the rule's text**, rendering it as *"the ball has touched an
opponent's hand/arm"* when the actual source text says "their" (the
scorer's own). That is not just a failure to hedge; it is misquoting the
source to make an ungrounded ruling sound directly quoted. This is strong
evidence the model has a surface-level pattern-match ("handball
immediately before a goal → disallowed") that overrides careful
instruction-following even under a maximally explicit, mechanical version
of the instruction — general "reason more carefully" instructions are not
a reliable lever here.

**What worked: stating the specific fact directly, not asking the model to
derive it.** Rather than teaching a general skill (trace referents
carefully — tested above, failed), the fix states the one concrete,
verified fact as a standing rule, the same way the prompt already states
"answer football questions only" as a flat instruction rather than
something to reason toward:

> The handball rule that disallows a goal scored "from" or "immediately
> after" a hand/arm touch applies ONLY when the SAME player who touched
> the ball with their hand/arm is also the one who scores. It does NOT
> apply when a different player's hand/arm was involved (for example, a
> defender's or goalkeeper's accidental touch before a different player's
> shot goes in) — the documents do not state a ruling for that
> different-player scenario, so say so plainly instead of applying the
> same-player rule to it.

Verified live (2026-07-21), replacing the prior instruction's second bullet
with this one:
- Original bug reproduction question: **5/5 correct hedges** at
  `temperature: 0` (previously 5/5 failures with the original instruction,
  and 5/5 failures with the more-explicit variant above).
- Hedge question 2 (goalkeeper own-goal, already passing before): still
  correctly hedges — the answer is if anything more precise, explicitly
  noting the retrieved rule addresses goals scored *against* opponents.
- 3 spot-check golden questions, including one other handball question
  (checking the new instruction doesn't cause *over*-hedging on legitimate
  handball questions the corpus does cover): all answered confidently and
  correctly, no regression.

**Scope note:** this is a targeted, single-fact addition, not a general
mechanism — it fixes the one confirmed failure case, the same way issue
#64's fix was a single-chunk override rather than a corpus-wide sweep (see
that issue's own spec, §2, for the same "narrow and verified beats general
and untested" reasoning). It would not automatically generalize to a
different ambiguous rule elsewhere in the corpus if one is found later —
that would need its own investigation and its own targeted fact, following
this same method, not a broader "always trace referents" instruction,
which this investigation showed actively backfires.

**Known residual risk (2026-07-21, PR #76 round 2 — flagged by fresh Fable
review):** the new instruction states as a flat fact that "the documents
do not state a ruling" for the different-player scenario. This was true
for every retrieval this instruction was actually tested against (the
hedge question's real top-8 never surfaced anything beyond the Law 12 § 1
handball text across ~15 live runs this session), but it is not a
provably universal claim — the corpus does contain a general advantage
clause (`Law 5 › 3`, "allows play to continue when an offence occurs and
the non-offending team will benefit from the advantage") that is
topically adjacent and could, in principle, be retrieved alongside the
handball chunks for a differently-phrased version of this question. If
that ever happens, the instruction's absolute wording could cause an
incorrect hedge instead of engaging with genuinely relevant retrieved
text. Not fixed here — same proportionality reasoning as the rest of this
narrow, verified-against-observed-behavior fix: revisit if it's ever
actually observed, not preemptively engineered against a retrieval
combination that hasn't happened.

**Instruction produced by this round (SUPERSEDED 2026-07-21 — see §4.2.2.2
for why this did not hold up and what replaced it):**

> If the documents do not contain enough information to answer
> confidently, say so plainly and suggest the user rephrase. Do not
> guess. The handball rule that disallows a goal scored "from" or
> "immediately after" a hand/arm touch applies ONLY when the SAME player
> who touched the ball with their hand/arm is also the one who scores. It
> does NOT apply when a different player's hand/arm was involved (for
> example, a defender's or goalkeeper's accidental touch before a
> different player's shot goes in) — the documents do not state a ruling
> for that different-player scenario, so say so plainly instead of
> applying the same-player rule to it.

This wording passed its own validation (5/5 on the original reproduction
question, no regression on hedge Q2 or 3 spot-check golden questions) and
was carried by PR #76 through 5 review rounds without any reviewer
independently re-phrasing the reproduction question to check for
overfitting. It shipped only as far as this docs branch — never applied to
`lib/answer.ts` — before Markus's own manual test in the next round found
it didn't actually hold up. See §4.2.2.2.

##### 4.2.2.2 Third investigation: the fix was overfit to one phrasing, not the underlying rule (2026-07-21)

**What broke it:** Markus tested the instruction above with his own
phrasing of the identical scenario — real player names, active-voice
sentence structure ("Luka Modric took a shot... the shot hit the arm of
opposition player John Stones... Does that count?") instead of the
established reproduction question's phrasing ("a player shoots a shot and
it bounces off the arm of an opponent..."). Result: **3/3 failures**,
deterministic, same wrong ruling as before any fix existed — the model
never engaged the same-player/different-player distinction at all.

**Isolating test (controlling session):** to check whether the failure was
caused by the named entities specifically, re-ran the identical sentence
structure with the names stripped back to generic roles ("A player took a
shot... the shot hit the arm of an opposition player... Does that
count?"). **Also failed, 5/5, identically.** This ruled out named entities
as the cause and proved something more serious: the §4.2.2.1 instruction
was fixing the *surface phrasing* of the one question it was validated
against, not the underlying rule it claimed to encode. The established
reproduction question and this generic rewording describe the exact same
scenario; only sentence structure differs.

**Root cause, diagnosed by Opus (dispatched as designer, not reviewer —
see `FABLE-HANDOFF.md` for the full process note on this):** the answer
model has a strong pretrained prior that "ball touches an arm right before
a goal → handball → disallowed," reinforced by real-world football
controversies in its training data. The §4.2.2.1 instruction stated the
same-player/different-player distinction as one flat sentence buried
mid-bullet — strong enough to win against that prior on the one phrasing
it happened to be tested against, but not reliably strong enough in
general. Whether the prior wins is phrasing-dependent, not scenario-
dependent, which is exactly what made the bug invisible to a single-
phrasing validation.

**What actually held up:** moving the distinction out of the buried bullet
into a dedicated, prominent trailing section that forces an explicit
two-role-identification step (who scored, whose hand/arm was touched)
before any ruling, rather than stating the distinction as a fact to recall:

> Handball and goals — read carefully before answering any question where
> a goal is scored and the ball touched a hand or arm:
> The Laws of the Game only disallow a goal for handball when the player
> who SCORES is the same player whose hand/arm the ball touched (scoring
> "directly from" or "immediately after" a touch of their OWN hand/arm).
> Where the Laws say the ball "touched their hand/arm", "their" means the
> scorer's own hand/arm.
> Before ruling, work out two things: who scored, and whose hand/arm the
> ball touched.
> - If they are the SAME player, the goal is disallowed.
> - If they are DIFFERENT players (for example the ball deflected off an
>   opponent's, a defender's, or a team-mate's hand/arm before a different
>   player scored), the Laws of the Game do NOT give a ruling for that
>   situation. In that case you must NOT say the goal is disallowed, does
>   not count, or is a handball offence. Instead, say plainly that the
>   Laws of the Game do not specify a ruling for that exact situation and
>   suggest the user rephrase or check with a match official.

**Validation, this round — deliberately across many phrasings, not one:**
10 distinct phrasings of the different-player scenario, 5 runs each at
`temperature: 0`, all 5/5 correct hedges: the original reproduction
question; both of Markus's variants (named opponent, named teammate); the
controlling session's generic isolating test; and 5 more Opus generated
itself (a defender's hand, a goalmouth-scramble deflection, a cross
deflecting off an outstretched arm, a second named-player pairing, a ball
"clipping" an elbow). Regression checks against two same-player scenarios
and existing golden questions (own-goal-scored-off-goalkeeper's-arm,
backpass, offside) confirmed no new over-hedging — all still ruled
confidently and correctly. The controlling session independently re-ran
the two specific cases that broke the prior instruction (3x each, from
scratch, against the live corpus/API) after receiving Opus's report rather
than trusting the summary alone — matched exactly, 3/3 both.

**Scope note (unchanged from §4.2.2.1, still applies):** this remains a
targeted, single-scenario patch, not a general fix for "corpus states a
rule for configuration X, question asks about configuration Y." Opus's own
stated caveat: this generalizes far better than the superseded wording but
is not a proof of zero remaining adversarial phrasings, and the general
class would need the rejected §4.1 claim-verification architecture to
close fully. The §4.2.2.1 residual risk note about the `Law 5 › 3`
advantage clause still applies unchanged — this revision does not touch
that risk.

**Final instruction** (`SYSTEM_PROMPT`, `lib/answer.ts` — replaces the
§4.2.2.1 second bullet and adds a new trailing section, superseding both
prior versions in this file's history):

> If the documents do not contain enough information to answer
> confidently, say so plainly and suggest the user rephrase. Do not
> guess.
>
> Handball and goals — read carefully before answering any question where
> a goal is scored and the ball touched a hand or arm:
> The Laws of the Game only disallow a goal for handball when the player
> who SCORES is the same player whose hand/arm the ball touched (scoring
> "directly from" or "immediately after" a touch of their OWN hand/arm).
> Where the Laws say the ball "touched their hand/arm", "their" means the
> scorer's own hand/arm.
> Before ruling, work out two things: who scored, and whose hand/arm the
> ball touched.
> - If they are the SAME player, the goal is disallowed.
> - If they are DIFFERENT players (for example the ball deflected off an
>   opponent's, a defender's, or a team-mate's hand/arm before a different
>   player scored), the Laws of the Game do NOT give a ruling for that
>   situation. In that case you must NOT say the goal is disallowed, does
>   not count, or is a handball offence. Instead, say plainly that the
>   Laws of the Game do not specify a ruling for that exact situation and
>   suggest the user rephrase or check with a match official.

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

- **Golden + paraphrase (~40-42 total, exact count depends on `main`'s
  state — see below):** 100% still cite their single required breadcrumb
  at temperature 0; no refusals or degenerate output.
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

**Note on the golden count (added 2026-07-20, independent fresh Fable
review, PR #73):** as of this spec's authoring, `main` has 30 golden
questions (40 golden + paraphrase total), not 32 (42 total) — issue #64's
PR #72, which adds 2 golden sentinels, had not yet merged. If it merges
before this fix executes, the real total becomes 42; the implementation
plan's Global Constraints section already carries this same caveat for
its own task numbering.

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
  bite today. **Corrected 2026-07-20 (Fable review, PR #73):** because
  this app sets `temperature: 0`, not `1.0`, there is no silent-coercion
  path for it — the SDK's own quoted text only accepts `1.0` silently, so
  the only failure mode past the deprecation cutoff is a loud 400
  rejection. That's a full outage of the `/api/ask` generation endpoint,
  not a silent quality regression — a stronger case for a real mitigation
  than a source comment alone.

  `ANSWER_MODEL` in `lib/answer.ts` is deliberately env-swappable ("one
  line to trade up to Sonnet/Opus," per its own code comment) — but the
  actual mechanism for swapping it is the `ANTHROPIC_MODEL` **Railway
  environment variable** (documented in this project's CLAUDE.md Secrets
  section), not a code change. A comment at the `temperature: 0` call
  site in `lib/answer.ts` is invisible to whoever performs that swap —
  they would edit the Railway env var and never open that file. The
  implementation plan's mitigation must therefore live where that person
  would actually see it: a warning in CLAUDE.md's `ANTHROPIC_MODEL`
  documentation itself — this is the actual prevention, since it's read
  before the change is made — plus a runtime allowlist check (known-safe
  model name substrings) that logs a clear warning server-side if
  `ANSWER_MODEL()` doesn't match. **The runtime check is a diagnostic aid,
  not a preventive one** (corrected 2026-07-20, independent fresh Fable
  review, PR #73): it fires from inside `streamAnswer` on the same
  request that already receives the breaking 400, so it doesn't reduce or
  prevent the outage window — it only makes the resulting server log line
  easier to find after the fact. Not a throw (a false negative on an
  unmaintained allowlist shouldn't break the endpoint on its own). **The
  allowlist itself must be kept in sync with the CLAUDE.md doc note**
  (added 2026-07-20, fourth independent Fable review, PR #73): the
  CLAUDE.md instruction to re-verify `temperature: 0` before a model swap
  now also says to add the new model to `KNOWN_TEMPERATURE_SAFE_MODELS`
  once verified — otherwise every legitimate future swap after the first
  would trigger a permanent false-alarm warning on every request.

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
| 2026-07-20 | Fable review (PR #73, fresh dispatch): found the §6 deprecation risk mitigation was placed where the actual risk-triggering action (a Railway `ANTHROPIC_MODEL` env var change) would never see it, and that the risk's own wording misstated the SDK's documented behavior (no silent-coercion path for this app's `temperature: 0` — only a loud 400). Root-cause analysis, chosen fix, and both new compound-questions.json entries (retrieval rank included, not just DB content) independently re-verified live and confirmed accurate. Fixed: corrected the wording, elevated the mitigation to a CLAUDE.md doc update plus a runtime allowlist warning (implementation plan Task 1 updated to match). |
| 2026-07-21 | **Mid-execution finding, this revision:** Task 6's live verification (implementation on `fix/generation-grounding-gap`, PR #73's spec/plan already merged) found the shipped prompt hardening (§4.2.2's original instruction) did not fix the issue's own primary reproduction question — 5/5 confident, incorrect assertions at `temperature: 0`, consistent rather than nondeterministic. Investigated live rather than patching ad hoc: confirmed the retrieved passage isn't actually grammatically ambiguous (single consistent subject throughout); tested a more explicit "trace pronoun referents" instruction, which failed *worse* (5/5, plus the model began misquoting the source text, inserting a word — "opponent's" — that isn't in the actual passage); tested a targeted, single-fact instruction stating the specific rule scope directly instead of asking the model to derive it, which fixed the target case 5/5 with no regression on the already-passing second hedge question or 3 spot-check golden questions (including another handball question, checked specifically for over-hedging). §4.2.2 revised with the full investigation and the new instruction — see §4.2.2.1. This is the fifth review-branch revision cycle this project has now used for a mid-execution finding requiring a real design change rather than a code patch (see this project's spec/plan-revision rule, `CLAUDE.md` → Global conventions). |
| 2026-07-21 | **Second mid-execution finding, this same revision:** the §4.2.2.1 instruction — already through 5 PR #76 review rounds and never applied to any code — turned out to be overfit to the surface phrasing of its one validated test question, not the underlying rule. Markus's own manual test (real player names, different sentence structure, identical scenario) failed 3/3; a controlling-session isolating test (same structure, names stripped) also failed 5/5, ruling out named entities as the cause and proving the phrasing itself was the variable. Rather than continue ad hoc wording iteration in-session — the same pattern that produced both broken "fixes" so far — dispatched Opus explicitly in a **designer** role (not reviewer), instructed to reproduce the failure independently, diagnose the actual mechanism, and validate any proposed fix live across multiple self-generated phrasings before reporting back. Opus correctly diagnosed the model's pretrained "arm touch near a goal → handball" prior overriding a single buried instruction sentence in a phrasing-dependent way, and produced a restructured instruction (explicit two-role-identification step, moved to a prominent trailing section) validated 5/5 across 10 varied phrasings plus same-player/golden-question regression checks. Controlling session independently re-verified the two specific breaking cases from scratch afterward (3/3 each, matching exactly) before accepting the result. §4.2.2 revised again — see §4.2.2.2 for the full investigation and the new final instruction. This is the first time Opus has been used as a designer rather than a reviewer on this project; process observations recorded in `FABLE-HANDOFF.md`. |
