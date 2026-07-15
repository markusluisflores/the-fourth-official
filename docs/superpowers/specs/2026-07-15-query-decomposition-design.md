# Query Decomposition — Design Spec

**Date:** 2026-07-15 · **Status:** Approved (Markus, 2026-07-15, in-session)
**Tier:** Standard (retrieval layer), with security review added on the decompose
task (see §9). Traces to the compound-question eval spec
(`2026-07-14-compound-question-eval-design.md` §6, whose sketch this supersedes)
and its measured baseline: 2 of 9 compound questions — including the original
red-card failure — never reach full coverage even at k=24, so raising k cannot
fix them.

## 1. Problem

Single-pass retrieval embeds the visitor's question once and searches once. A
compound question ("What happens if everyone on a team gets a red card?") needs
passages from several law sections at once, and one embedding cannot sit close
to all of them — coverage stalls no matter how many results are fetched
(baseline: stuck at 2/4 required sections through k=24). The fix is to retrieve
*per concept*: split the question into self-contained sub-questions, search for
each, and merge.

**Build decision is settled** (2026-07-15): raising k was measured and ruled out
for the hardest cases; decomposition is the only remaining candidate. This spec
decides *how*, not *whether*.

## 2. Goals / Non-goals

**Goals**

1. Compound questions retrieve the sections a complete answer needs; the
   compound eval tier's full-coverage rate improves over the recorded 3/9 @ k=8.
2. Simple questions (the majority) keep the same retrieval results and the
   same behavior on any decomposer failure. Latency is *bounded*, not
   guaranteed byte-for-byte identical: a soft deadline (§3, §4) caps the
   worst-case added wait instead of exposing every request to decompose's
   full ~3s budget (revised 2026-07-15 — the original "same latency,
   unconditionally" framing didn't hold under the reference implementation;
   see the revision-history entry).
3. The improvement is a reproducible number: an opt-in eval mode runs the
   decomposed path against the compound tier.

**Non-goals**

- No change to the golden-set path, `RELEVANCE_THRESHOLD`, `match_chunks`, or
  per-sub-question k=8.
- No UI change — merged chunks render in the existing glass box.
- No corpus expansion (VAR-protocol back matter stays unindexed).
- No caching/memoization of decompositions (20-questions/day scale; YAGNI).
- Byte-for-byte identical latency for every simple question is explicitly not
  a goal (revised 2026-07-15): the soft-deadline mechanism (§3) makes
  compound detection timing-dependent by design, in exchange for a bounded
  worst case. See §7's residual-risk entry.

## 3. Architecture

The `/api/ask` pipeline keeps its shape — validate → rate-count → retrieve →
gate → stream — with the retrieve stage widened:

```mermaid
flowchart TD
    A[validate + rate-count<br/>unchanged] --> B[baseline retrieval<br/>searchChunks q, k=8]
    A --> C[decompose call<br/>Haiku, structured JSON, ~3s hard budget]
    C -->|answers within the route's<br/>soft deadline| D{1 sub-question,<br/>or any failure?}
    C -->|misses the soft deadline<br/>DECOMPOSE_SOFT_DEADLINE_MS| S[treated as simple for<br/>this request; the real call<br/>keeps running unseen, result discarded]
    D -->|yes| S
    D -->|no, 2-4 subs| E[embed all sub-questions<br/>in ONE Voyage call]
    E --> F[match_chunks per sub-question,<br/>in parallel]
    B --> G[merge: round-robin by rank,<br/>dedupe by id, cap 12]
    F --> G
    S --> H[relevance gate on max similarity<br/>unchanged logic]
    G --> H
    H --> I[streamAnswer with ORIGINAL question<br/>+ chunks — unchanged]
```

Key properties:

- **Parallel, bounded by a soft deadline** (revised 2026-07-15 — see the
  2026-07-15 revision-history entry for why): the decompose call and the
  baseline retrieval fire concurrently, but the route only waits on decompose
  up to `DECOMPOSE_SOFT_DEADLINE_MS` — a route-level deadline distinct from,
  and much shorter than, decompose's own ~3s hard budget (§4). If decompose
  hasn't answered within the soft deadline, the request proceeds on the
  baseline result alone, exactly as if decompose had returned a single
  sub-question; the abandoned decompose call keeps running to completion in
  the background (it cannot reject — §4 — so nothing needs cleanup) and its
  result is simply never read. This bounds a simple question's worst-case
  added latency to the soft deadline instead of decompose's full budget, at
  the cost of making compound detection genuinely timing-dependent — see the
  Known residual risk in §7 and the Non-goal in §2.
- **The answering model never sees sub-questions.** `streamAnswer(question,
  chunks)` receives the visitor's original question; decomposition steers
  retrieval only.
- **The decomposer is an optimization, never a dependency.** Every failure mode
  (§6) lands on the simple path — byte-for-byte today's behavior.

New code lives in `lib/decompose.ts` (call + parse/validate + both the hard
timeout and the soft-deadline constants) and a merge function in
`lib/retrieval.ts` beside the existing result helpers, per the Global
Constraint that logic never lives in `app/`. The soft-deadline race itself is
route-only wiring (`app/api/ask/route.ts`); the eval's `--decompose` mode
(§9) deliberately does not apply it, since that mode measures full
decomposition coverage, not production latency.

## 4. Decompose contract

- **Model:** fixed constant `claude-haiku-4-5` — deliberately *not*
  `ANSWER_MODEL()`, so upgrading the answering model never silently raises the
  splitter's cost. Reuses the existing Anthropic SDK client setup.
- **Output:** structured outputs (`output_config.format`, JSON schema) — the
  API guarantees the response parses as `{ "sub_questions": string[] }`.
- **Prompt:** system prompt contains instructions only ("split into 1–4
  self-contained sub-questions about football rules; return exactly 1 if the
  question is already simple"); the visitor's question goes in the user message
  as data — same discipline as `lib/answer.ts`.
- **Post-parse validation (code, since JSON Schema can't express item
  counts):** trim and drop empty strings; if more than 4 remain, keep the
  first 4; if 0 remain → fallback. Result of exactly 1 → simple path.
- **Budget:** two separate timeouts, deliberately not conflated:
  - `DECOMPOSE_TIMEOUT_MS` (~3s, unchanged) — the SDK-level hard timeout on
    the call itself, inside `decompose()`. On expiry the call rejects the
    promise internally and `decompose()` resolves to `null`, same as any
    other failure mode.
  - `DECOMPOSE_SOFT_DEADLINE_MS` (proposed 800ms, both exported from
    `lib/decompose.ts`) — a route-level deadline (§3) for how long `/api/ask`
    will wait on decompose's answer before giving up on this request and
    proceeding as simple. This is *not* a property of `decompose()` itself —
    the function's own contract (never rejects, ~3s budget) is unchanged;
    the route just stops listening for the answer earlier. 800ms is an
    initial estimate (baseline retrieval — one embed call plus one Postgres
    RPC — is typically well under a second; Haiku structured-output calls on
    a small token budget are usually fast but not guaranteed), to be
    validated by Task 5's latency sampling (§10) before merge.

## 5. Merge policy

Inputs: the baseline ranked list plus one ranked list per sub-question (each up
to 8 chunks, ordered by RRF score from `match_chunks`).

1. **Round-robin by rank:** all rank-1 chunks first (baseline list first, then
   sub-questions in order), then all rank-2, and so on — each sub-question's
   best evidence survives the cap instead of one list's tail crowding out
   another's head.
2. **Dedupe by chunk id**, keeping the first (best-ranked) occurrence.
3. **Cap at 12 chunks** (§6 of the eval spec; a modest generation-cost increase
   over k=8, paid only on compound questions).
4. **Gate semantics:** `maxSimilarity` of the merged result = max across *all*
   contributing results. `isRelevant` and the 0.35 threshold are unchanged; an
   off-topic question stays sub-threshold however it is split, preserving
   abstain behavior.

## 6. Error handling

| Failure | Handling |
|---|---|
| Decompose call errors (network, 429, 5xx) | Fall back to baseline; log warning |
| `stop_reason: "refusal"`, malformed or empty output | Same fallback |
| Decompose exceeds ~3 s (its own hard budget) | Abandon call; baseline path |
| Decompose answers after the route's soft deadline but before its own ~3s hard budget | Route already proceeded on baseline for this request; the late answer is discarded, not used, not retried |
| Sub-question batch embed fails (e.g. Voyage free-tier 429 burst) | Baseline path |
| One sub-question's `match_chunks` fails | Merge the lists that succeeded (baseline included) |
| Baseline retrieval fails | 502 — same as today; the one fatal error, already fatal now |

No retries in the decomposer: with a live visitor waiting, falling back beats
retrying.

## 7. Cost & latency

- **Simple questions:** decompose runs concurrently with baseline retrieval,
  raced against `DECOMPOSE_SOFT_DEADLINE_MS` (§3, §4). Total added latency is
  `max(baseline, min(decompose, soft deadline))`. In the common case (Haiku
  answers within the soft deadline) this is ≈ 0 over baseline alone, same as
  originally intended; the worst case is now capped at the soft deadline
  (proposed 800ms) instead of decompose's full ~3s budget. This replaces the
  original "added wait ≈ 0, unconditionally" claim, which a task-review pass
  (2026-07-15) found didn't actually hold under the reference `Promise.all`
  shape — see the revision-history entry below.
- **Compound questions:** one extra embed round-trip + parallel searches; ~1 s
  extra before streaming starts (unchanged).
- **Spend:** one Haiku call per question (cent-fractions), bounded by the
  existing 20/day visitor cap and global ceiling; the rate-count precedes the
  decompose call, so gated/rate-limited questions never reach Haiku. No new
  guardrail work. Note: an abandoned (soft-deadline-missed) decompose call
  still completes and still costs the same Haiku call — the soft deadline
  changes what the route waits for, not what gets spent.
- **Known residual risk (Voyage burst):** Voyage free tier allows 3
  requests/minute; compound questions add a second embed call, so a burst can
  429 the sub-question embed. The fallback covers it — worst case is
  decomposition silently not helping during the burst.
- **Known residual risk (timing-dependent compound detection, new
  2026-07-15):** a genuinely compound question can occasionally be treated as
  simple if decompose's answer arrives after the soft deadline — the same
  question could get different treatment on different requests depending on
  Haiku's response time that request. Accepted: it trades a rare, bounded
  quality loss (one compound question, one request, gets simple-path
  retrieval) for capping every request's worst-case latency, rather than
  exposing every request to up to 3s of added wait for the sake of catching
  the rare slow-decompose case. Task 5's latency sampling records how often
  decompose's real latency exceeds the soft deadline, as a proxy for how often
  this actually happens.

## 8. Threat model note

The decomposer is the first production code where an LLM's output steers later
processing, so its output is constrained hard:

- Output is schema-bound JSON (structured outputs), then code-validated.
- Parsed sub-questions are **data only**: they flow into `embedTexts` and the
  `match_chunks` `query_text` parameter, and are never concatenated into any
  prompt (the answer model receives only the original question; the decomposer
  system prompt contains no user content).
- Worst case from a hostile question is therefore bad retrieval — the same
  worst case an arbitrary weird question produces today, already bounded by the
  relevance gate and the answer model's answer-only-from-documents rules.

## 9. Testing & reviews

**Unit tests** (Vitest, `tests/` mirroring `lib/`):

- Parse/validate (pure): valid 2–4 splits; single; empty strings dropped; >4
  truncated; garbage → fallback signal.
- Merge (pure): round-robin order; dedupe keeps best rank; cap 12; empty
  lists; merged `maxSimilarity` across all sources.
- `decompose()` with an injected mock Anthropic client (the `streamAnswer`
  pattern): happy path, refusal, error, timeout — all falling back.
- Existing route tests continue to cover the simple path unchanged.
- **Route soft-deadline race (new 2026-07-15):** using fake timers (or a mock
  `decompose` that resolves after a controllable delay), verify (a) a
  `decompose` mock that resolves before `DECOMPOSE_SOFT_DEADLINE_MS` still
  drives the compound path normally, (b) a mock that resolves after the soft
  deadline is treated as simple for that request, and (c) the late-resolving
  mock's eventual result has no observable effect once the response has
  already been produced (no dangling state, no unhandled rejection — it
  can't reject per §4, but assert the resolved value is simply never read).

**Eval mode:** `npm run eval -- --decompose` runs the compound tier through
decompose → multi-retrieve → merge and prints the same per-question coverage
table plus summary. Requires `ANTHROPIC_API_KEY` (present in `.env.local`);
costs ~a cent; mildly nondeterministic (an LLM chooses the split). The default
`npm run eval` is untouched — free, deterministic, same gates.

**Reviews:** Standard tier (per-task two-stage + `reviewer` agent), **plus**
`/security-review` and the `security-reviewer` agent on the decompose task
specifically — a deliberate half-step above Standard scoped to the one new
user-input→LLM surface.

## 10. Regression bar (all must hold before merge)

1. Golden 30/30 recall@8, paraphrase, and abstain results unchanged (default
   eval path and production simple path are untouched code).
2. Compound tier full coverage improves over the recorded 3/9 @ k=8 in
   `--decompose` mode; before/after numbers recorded in this spec's revision
   history and `docs/project-reviewer.md`.
3. End-to-end acceptance: the original red-card question, asked in the deployed
   app, produces a correct "an abandoned match does not become a penalty
   shoot-out" ruling. Manual check by Markus (password gate blocks agent
   click-testing — same arrangement as Part 2b).
4. Soft-deadline validation (new 2026-07-15): latency sampling confirms
   `DECOMPOSE_SOFT_DEADLINE_MS`'s added latency is small for simple questions
   in practice, and records how often decompose's real latency exceeds the
   soft deadline — the measured proxy for how often a genuinely compound
   question gets timed out into the simple path. Numbers recorded in this
   spec's revision history alongside the coverage numbers.

## 11. Deliverables (implementation plan's checklist)

1. `lib/decompose.ts` — Haiku call, structured output, parse/validate, timeout,
   fallback signal + unit tests.
2. Merge function + route wiring (parallel fire, merge, gate) + unit tests.
3. Eval `--decompose` mode.
4. Measurement: `--decompose` compound run recorded; regression bar checked;
   docs (this spec's revision history, `project-reviewer.md`, README limitation
   line updated to note the fix).

~4–5 tasks; one plan; Standard-tier execution suitable for a cheap-model
session per the established split.

## 12. Risks

- **Decomposer splits badly** (over-splits simple questions, or splits into
  off-corpus concepts): bounded by the merge cap, the unchanged gate, and the
  answer model seeing only the original question; measured by the compound tier
  and golden-set invariance.
- **Overfitting to the 9-question tier:** the tier is a yardstick, not a proof
  — hence the end-to-end acceptance check on the live app (§10.3).
- **Voyage free-tier burst 429s** (§7): accepted; fallback degrades gracefully.

## Revision history

| Date | Change |
|---|---|
| 2026-07-15 | Initial spec — approved in-session (parallel architecture, opt-in eval mode). |
| 2026-07-15 | Retrieval-timing redesign: Task 3's task-review pass found that the reference `Promise.all([searchChunks, decompose])` shape (§3, as originally given in the implementation plan) blocks *every* request — including simple ones — on decompose's full latency, contradicting Goal 2's "added wait ≈ 0" claim; the route's own comment claiming a "race" was inaccurate for `Promise.all` semantics. Replaced with a bounded soft-deadline race: the route waits on decompose only up to `DECOMPOSE_SOFT_DEADLINE_MS` (proposed 800ms, separate from decompose's own ~3s hard budget), falling back to the baseline path if decompose hasn't answered in time. Trades a new, disclosed risk (compound detection becomes timing-dependent — §7) for a bounded worst-case latency instead of an unconditional one. Approved by Markus (brainstorming session, 2026-07-15) pending Fable's design review on this PR before merge. |
