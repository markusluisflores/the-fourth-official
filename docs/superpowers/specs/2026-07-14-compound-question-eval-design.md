# Compound-Question Eval Tier — Design Spec

**Date:** 2026-07-14 · **Status:** Approved (Markus, 2026-07-14, in-session)
**Scope decision:** measure now, sketch the fix — no retrieval-layer change is
built from this spec. Traces to the Part 2b handoff finding (NEXT-SESSION.md
item 1, 2026-07-13) and the PR #27 review ruling (PR #27 review comment,
2026-07-14).

## 1. Problem

Single-pass k=8 hybrid retrieval cannot fully cover questions whose complete
answer spans several law sections at once. Verified live instance: "What
happens if everyone gets a red card?" retrieves chunks across Law 3, Law 5,
Law 10 § 3, and Law 12 — but not Law 10 § 2 ("Winning team") or the rest of
Law 10 § 3's intro, exactly the passages needed to answer "an abandoned match
does not become a penalty shoot-out." The generated answer cited what it
retrieved with complete accuracy; the gap is coverage, not citation fidelity.

The existing eval harness structurally cannot see this class of failure:
`scoreQuestion` treats a question's `expected` list with OR-semantics — any
one listed section in the top-k counts as a hit. Every golden question needs
only one section to be answerable. Compound questions need AND-semantics:
all required sections retrieved together, or the answer is incomplete.

## 2. Goals / Non-goals

**Goals**
1. A measurement instrument: a compound-question eval tier with AND-coverage
   scoring, so the limitation has a number instead of an anecdote.
2. A decision instrument: per-question coverage at k = 8/12/16/24 (eval-side
   only), so the future "raise k vs. decompose vs. accept" choice is a data
   lookup, not speculation.
3. An honest public record: baseline numbers recorded, and a one-line
   known-limitation note in the README.

**Non-goals (explicitly out of scope)**
- Any change to production retrieval (`lib/retrieval.ts`, `match_chunks`,
  k=8, `RELEVANCE_THRESHOLD`) — all frozen.
- Building query decomposition (§6 is a sketch for a future spec/plan cycle).
- End-to-end answer grading with an LLM judge (noted in §6 as the eventual
  acceptance test if the fix is ever built; wrong tool for isolating a
  retrieval-layer gap, and it adds paid calls + judge noise per eval run).

## 3. The eval tier

**File:** `evals/compound-questions.json`

```json
[
  {
    "question": "What happens if everyone on a team gets a red card?",
    "required": ["Law 3 › 1", "Law 10 › 2", "Law 10 › 3"],
    "note": "abandonment vs shoot-out confusion — the known Part 2b failure"
  }
]
```

- `required` is an AND-list: a full answer needs every listed section.
  (Contrast with the golden set's `expected`, an OR-list — that file and its
  30/30 gate are untouched.)
- `note` documents why the question is compound — for future readers, never
  read by scoring.
- 8–10 questions, each requiring 2–4 sections, mixing the known failure with
  other genuinely multi-law scenarios (e.g. substitute misconduct during a
  penalty shoot-out; goalkeeper injured with no substitutions remaining).
- **Human checkpoint:** Markus reviews and approves the batch for football
  correctness — both the questions and their `required` labels — before the
  baseline is recorded (same arrangement as the golden set, whose review
  caught a real labeling error). A wrong `required` list makes the tier lie
  in either direction, so unreviewed labels are worthless.

## 4. Scoring

New pure function in `evals/run-evals.ts`, beside the existing ones, reusing
`matchesExpected` (the segment-aware prefix matcher — no new matching logic):

```ts
// fraction of required sections with at least one matching chunk in the top-k
export function coverageScore(
  chunks: { breadcrumb: string }[],
  required: string[],
): number;
```

Reported per tier run:
- **Full-coverage rate** — questions where every required section was found.
- **Mean coverage** — average fraction found (partial progress registers).
- Per-question detail lines naming which required sections were missed.

Pure function → unit tests in `tests/evals.test.ts` next to the existing
scoring tests (found/missed/empty/duplicate-section cases).

## 5. Multi-k diagnostic

Each compound question runs at k=8, 12, 16, 24 via `searchChunks`'s existing
`k` parameter — eval-side only. Output is a per-k coverage table.

- **Separate retrieval calls per k, deliberately.** Fetching k=24 once and
  slicing prefixes assumes the RPC's RRF ranking is prefix-stable
  (top-8-of-24 ≡ k=8 result), which is not guaranteed — `match_count` can
  affect candidate pools before fusion. Correctness over cleverness.
- Cost: ~40 retrieval calls (10 questions × 4 ks); the existing
  `searchWithRetry` 429 backoff already survives Voyage's free-tier pace
  (precedent: the full eval run does today). Re-embedding the same question
  per k call is accepted waste (free-tier tokens, zero dollars).

**The decision rule this feeds** (recorded here so the future session reads
the table instead of re-arguing):

| Diagnostic outcome | Implication |
|---|---|
| Coverage poor even at k=24 | Raising k was never the answer; decomposition (§6) is the only real candidate |
| Full coverage reached at some k ≤ 24 | A cheaper option exists: raise generation k — then it's a measured cost tradeoff (more document tokens/question vs. an extra LLM call), decided with numbers |
| k=8 coverage acceptable in practice | Document and stop — for a password-gated demo with a 20/day cap, the honest limitation may be good enough |

## 6. Future-work sketch: query decomposition (NOT built by this spec)

Recorded so whoever builds it starts warm; supersede freely in its own spec.

- Pre-retrieval Claude Haiku call, tight JSON contract: "split this question
  into 1–4 self-contained sub-questions; return 1 if already simple."
- Simple questions (the common case) take today's exact path — zero
  regression surface.
- Compound: retrieve k=8 per sub-question; merge by chunk id keeping each
  chunk's best rank; cap the merged set (~12 documents) before generation to
  bound cost. Relevance gate applies to the merged result's max similarity,
  preserving abstain semantics.
- Costs: one extra Haiku call (cent-fractions) + up to 3 extra
  retrieval round-trips + roughly a second of latency on compound questions.
- **Tier: Standard** (retrieval layer). Own spec → plan → full review battery.
  Regression bar: golden 30/30, paraphrase, abstain all hold; compound tier
  improves. End-to-end acceptance: the red-card question produces a correct
  "no shoot-out after an abandonment" ruling.

## 7. Deliverables (implementation plan's checklist)

1. `evals/compound-questions.json` — drafted, then Markus-approved (blocking).
2. `coverageScore` + unit tests.
3. Tier wired into `npm run eval` (informational, after abstain; never a gate).
4. Multi-k diagnostic table in the eval output.
5. Baseline run recorded: numbers into this spec's revision history + the
   interview guide (`docs/project-reviewer.md`).
6. README known-limitation line (user-facing phrasing).

## 8. Risks

- **Label correctness** is the load-bearing risk — mitigated by the human
  review checkpoint (§3).
- **Overfitting the future fix to this tier**: 8–10 authored questions are a
  yardstick, not a proof; §6's acceptance test deliberately includes an
  end-to-end check, not just this tier.
- **Tier misread as a failure**: the eval output labels it informational,
  and the README line frames it as a documented boundary of a k=8 demo, not
  a defect.

## Revision history

| Date | Change |
|---|---|
| 2026-07-14 | Initial spec — approved in-session (scope A: measure now, sketch fix). |
