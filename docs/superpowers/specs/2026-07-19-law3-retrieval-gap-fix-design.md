# Law 3 § 1 Retrieval Gap Fix — Design Spec

**Date:** 2026-07-19 · **Status:** Approved (Markus, 2026-07-19, in-session)
**Scope decision:** targeted, single-chunk fix only — no general-purpose
mechanism. Traces to issue #64 (filed 2026-07-19, query-decomposition Step 7
click-test) and the compound-eval baseline first measured in
`2026-07-14-compound-question-eval-design.md`.

## 1. Problem

For the question "What happens if everyone on a team gets a red card?",
retrieval never surfaces `Law 3 › 1. Number of players` — the section stating
the actual governing rule ("A match may not start or continue if either team
has fewer than seven players"). Confirmed deterministic and 100%
reproducible: 5/5 identical runs against the live corpus, same similarity
scores each time (~0.462–0.463 for the top hit), Law 3 § 1 absent from the
top-8 in every run.

**Root cause:** Law 3 § 1's stored text shares almost no surface vocabulary
with "everyone gets a red card." The inferential chain (red card → player
sent off → team's count drops → possibly below seven) isn't captured by
either retrieval lane already running in `match_chunks` — dense-vector
cosine similarity (the chunk's embedding doesn't land close to the
question's embedding) or the existing keyword/full-text lane (`Law 3 › 1`'s
text contains no "red card" or "sent off" wording to keyword-match against).

## 2. Investigation before committing to a fix shape

Two rounds of live retrieval testing against the corpus, run before any
design decision, to answer "is this narrow or systemic":

**Round 1 — systemic check across other numeric-threshold Laws** (4
questions, indirect scenario phrasing deliberately avoiding each target
chunk's own vocabulary, same style as the red-card question):

| Target rule | Retrieved at k=8? |
|---|---|
| Law 3 › 2 (5-substitute cap) | rank 1 |
| Law 7 › 2 (15-min half-time cap) | rank 1 |
| Law 1 › 6 (16.5m penalty-area boundary) | rank 1 |
| Law 1 › 3 (90m minimum field length) | rank 4 |

All four succeeded. No evidence of a broader "numeric thresholds embed
poorly" pattern.

**Round 2 — two questions from the issue #64 comment's harvested material**
(different rule area — Law 12 § 4 disciplinary/DOGSO rules — chosen to
probe for the same *kind* of gap elsewhere in the corpus, not to re-test the
same rule):

| Question | Target | Retrieved at k=8? |
|---|---|---|
| "Second yellow via simulation" | Law 12 › 4 | rank 2 |
| "DOGSO downgrade" | Law 12 › 4 | rank 1 |

Both succeeded.

**Conclusion:** 6 of 6 control questions retrieved correctly; only the
original red-card question fails, and it fails consistently across 5
repeated runs. This is a confirmed, reproducible, narrow, one-off gap — not
a systemic corpus/embedding problem. A full corpus-wide sweep (~118 chunks,
each needing an authored indirect test question) was considered and
explicitly rejected as disproportionate: it would cost significant
question-authoring effort and over an hour of rate-limited embedding calls
to look for a problem this spot-check found no evidence of, for an issue
that is P2 and non-blocking. If a second or third instance of this class of
gap is found later, that would be a real signal to revisit this decision.

## 3. Goals / Non-goals

**Goals**
1. Fix retrieval for the confirmed case: the red-card question (and its
   phrasing class) should surface `Law 3 › 1` at k=8.
2. Preserve citation integrity: what a user sees cited as "Law 3 § 1" must
   remain the exact, unedited official rulebook text — no user-facing
   change to any displayed passage.
3. Keep the fix's blast radius to the one confirmed chunk. No new
   general-purpose mechanism (no synonym glossary, no query-rewriting
   layer, no corpus-wide re-chunking).

**Non-goals (explicitly out of scope)**
- A full sweep of the other ~117 chunks for similar gaps (§2 — considered,
  rejected as disproportionate for a confirmed one-off).
- Query-side expansion/rewriting (an LLM call that rephrases every incoming
  question before embedding) — rejected as architecturally heavier than one
  confirmed case justifies; see the rejected-approaches note in §4.
- Any change to `RELEVANCE_THRESHOLD`, `k` defaults, or the existing hybrid
  vector+keyword fusion logic in `match_chunks` — all untouched.

## 4. Design

### 4.1 Rejected approaches

- **Do nothing / keep as documented limitation.** Valid, zero-risk, and
  consistent with how this project already handled the compound-eval recall
  gap (accepted rather than chased). Rejected because the answer this
  produces today states the opposite of the real governing rule, for a
  plausible, high-visibility question a real user would ask — worth fixing
  given the fix is small.
- **Query-side expansion (rewrite the question via an LLM call before
  embedding).** Would not touch the corpus at all and could in principle
  generalize to catch other not-yet-discovered gaps. Rejected: adds latency
  and API cost to every question, is harder to test deterministically (LLM
  rephrasing isn't fully reproducible), and is disproportionate given §2
  found no evidence this is a broad problem.
- **Editing `content` directly** (the field displayed as the citation) to
  add the bridging sentence. Rejected outright: it would mean showing users
  non-official commentary as if it were an exact quote from the IFAB Laws of
  the Game, conflicting with the project's core citation-integrity promise.

### 4.2 Chosen approach: a display-invisible embedding-text override

Add one new nullable column to `chunks`:

```sql
alter table chunks add column embedding_text text;
```

Additive, nullable, no backfill, no risk to existing rows or queries —
inert until the ingest code starts writing it (§4.3). Nothing reads this
column programmatically; it's a provenance record for humans, not an input
to any query. For 117 of 118 chunks this column stays `null` forever; for
the one overridden row anyone reading it later can see exactly what text
its embedding was actually computed from, rather than that fact only
living transiently in `chunk.ts`'s override map with no
trace in the database.

**Confirmed via direct query against the live corpus:** `Law 3 › 1. Number
of players` is a single row (id 258, 740 chars, well under the 1500-char
`MAX_CHUNK_CHARS` split threshold) — the override applies cleanly to one
whole chunk, no multi-piece splitting to account for.

**Bridging text** (appended only to the hidden `embedding_text` field for
this one row — the original text is unchanged):

> "...This rule applies regardless of the reason a team has fewer than
> seven players, including when players are sent off — for example after
> receiving a red card — and the team's number of players falls below the
> seven-player minimum."

Deliberately phrased as "this rule applies regardless of the reason," not
"a red card always stops the match" — the stronger claim would be
inaccurate (a red card usually leaves a team well above seven players; it's
only relevant when it happens to push them under the threshold). The
sentence states an example of when the existing rule applies; it asserts
nothing new about football. Hand-written and reviewed in this spec, not
LLM-generated — deterministic, reviewable in the PR diff like any other
code/data change, and avoids the risk of an automated rephrasing drifting
into something subtly inaccurate about the Laws.

### 4.3 Ingest pipeline changes

Three edits, all in existing files:

1. **`scripts/ingest/chunk.ts`** — a small breadcrumb-keyed override map
   (one entry, for `"Law 3 › 1. Number of players"`) supplies the enriched
   text, as a full replacement string (the original text plus the bridging
   sentence appended), not a suffix concatenated separately at ingest time —
   so the map's value is exactly what gets embedded, with no string-building
   logic to get wrong. `RawChunk` gains an optional `embeddingText?: string`
   field, populated from this map after chunking. The map lookup must assert
   it matches **exactly one** chunk — breadcrumbs are not guaranteed unique
   across the corpus (e.g. `Law 3 › 2` already spans two rows today, from
   `splitOversize`), so a silent zero-match or multi-match would be a bug
   worth failing loudly on, the same defensive posture as
   `assertCompleteLawSet`'s existing loud-failure pattern in this file. The
   override map's value must also be asserted to start with the matched
   chunk's actual `content` (`embeddingText.startsWith(content)`) before
   ingest proceeds — this turns two otherwise-silent failure modes into loud
   ones: a hand-copy slip when the override text was written (typo drift
   from the real rulebook text), and future corpus drift if the source PDF
   is ever replaced with a newer Laws of the Game edition and the parsed
   text no longer matches what's hard-coded in the override map.
2. **`scripts/ingest/index.ts`, embedding step** — changes from
   `batch.map((c) => c.content)` to `batch.map((c) => c.embeddingText ??
   c.content)`. For every chunk except Law 3 § 1, `embeddingText` is
   `undefined`, so this is a no-op — identical behavior to today.
3. **`scripts/ingest/index.ts`, row-insert step** — the row-building map
   (currently `corpus_version`/`law_number`/`breadcrumb`/`content`/
   `embedding`) also writes `embedding_text: c.embeddingText ?? null`, so
   the new column (§4.2) is actually populated for the one overridden row
   instead of staying `null` for every row including that one.

`content` (and therefore what gets stored in the `content` column and shown
in citations) is never touched.

**Keyword/full-text lane is deliberately left unbridged.** Directly
verified against the live corpus: `websearch_to_tsquery('english', "What
happens if everyone on a team gets a red card?")` matches zero chunks via
the `fts` column, for this question as phrased — the keyword lane isn't
contributing anything for this case either way, so there's no reason to
touch the `fts` generated expression or its tsvector configuration as part
of this fix. Vector similarity alone is what §4.2's bridging text targets.

**Rollout, in two stages:**
1. **Dry-run validation first** — before committing to the full corpus
   re-ingest, embed the **full override string** (original Law 3 § 1 text
   plus the appended bridging sentence, §4.2's map value verbatim — not the
   bridging sentence alone, which is packed with red-card vocabulary and
   would trivially score high in isolation, a false pass) using the same
   `"document"` input type production ingest uses, and compare it against
   the red-card question embedded with the same `"query"` input type
   `searchChunks` uses. Confirm it would actually place in the top-8 with a
   real margin, not just a hair above today's 8th-place similarity score of
   0.389 — cosine similarity has third-decimal-place variance from run to
   run (observed directly during review), and every chunk gets re-embedded
   on a full re-ingest, so a razor-thin win here isn't a reliable predictor
   of a razor-thin win after the real rebuild. This is two Voyage calls (one
   `"document"`-type, one `"query"`-type — differing input types, not a
   single shared call), not a re-ingest, so it's cheap to check before
   spending time on a sentence that might not move the needle enough.
2. **Full re-ingest** — re-run the existing `npm run ingest` command, the
   same delete-and-reinsert-by-`corpus_version` process already in place
   (see `index.ts`'s existing comments on why this is safe as a
   single-batch operation). Not a new or higher-risk operation than what's
   already used for every corpus rebuild.

## 5. Testing / verification plan

1. **Direct confirmation:** re-run the exact reproduction test from §1
   (the red-card question through `searchChunks` at k=8) after the fix
   ships. Expect `Law 3 › 1` to now appear, where it was absent in all 5
   pre-fix runs.
2. **Existing eval entry, no new entry needed:** the red-card question is
   already the first entry in `evals/compound-questions.json`:
   ```json
   {
     "question": "What happens if everyone on a team gets a red card?",
     "required": ["Law 3 › 1", "Law 7 › 5", "Law 10 › 2", "Law 10 › 3"],
     "note": "The known Part 2b failure: ..."
   }
   ```
   Confirm its coverage score improves (specifically that `Law 3 › 1` is now
   found) and update the stale `note` field, which currently calls this
   "the known Part 2b failure" — no longer accurate once fixed.
3. **New regression sentinels in `evals/golden-questions.json`** — the two
   Round 2 questions (§2), which already pass today and should keep passing
   after the fix, confirming the change didn't disturb an unrelated part of
   the corpus (Law 12 § 4):
   ```json
   { "question": "A player who's already on a yellow card dives to win a free kick — does that automatically mean a second yellow and being sent off?", "expected": ["Law 12 › 4"] }
   { "question": "If a foul earns a penalty kick, does that let the referee give only a yellow card instead of a straight red for denying a goalscoring opportunity?", "expected": ["Law 12 › 4"] }
   ```
4. **Full no-regression check:** re-run the complete eval suite
   (golden/paraphrase/abstain/compound) to confirm nothing else moved —
   changing one chunk's fingerprint could in principle nudge its ranking
   relative to unrelated questions; this is the sanity check that the fix
   is isolated in practice, not just in theory.

## 6. Risks

- **Wording accuracy is the load-bearing risk** for the bridging sentence
  (§4.2) — mitigated by writing it deliberately (not LLM-generated) and
  reviewing the exact wording in this spec before implementation, same
  discipline as the compound-eval question batch's human review checkpoint.
- **Scope creep into a general mechanism**: explicitly rejected in §2/§3 —
  if this pattern recurs, that's a signal to revisit, not a reason to
  pre-build a glossary/rewriting system now on the strength of one case.
- **Coupling to a future corpus re-ingest**: if the source PDF is ever
  replaced with a newer Laws of the Game edition, the breadcrumb-keyed
  override map in `chunk.ts` could silently stop matching (if section
  numbering/wording changes) or apply to the wrong text. The eval sentinel
  in §5.2 (existing compound entry) provides some protection, but this is
  worth a comment in the override map itself pointing back to this spec.

## 7. Deliverables (implementation plan's checklist)

1. Migration: `alter table chunks add column embedding_text text`.
2. `chunk.ts`: `embeddingText?` field on `RawChunk` + one-entry override map,
   asserting exactly one breadcrumb match and that the override value
   starts with the matched chunk's real `content`.
3. `index.ts`: embedding step prefers `embeddingText ?? content`; row-insert
   step writes `embedding_text: c.embeddingText ?? null`.
4. Dry-run validation: two throwaway embedding calls (document-type override
   text, query-type question) confirming a real margin over the current
   8th-place similarity (0.389), not just a hair above it, before
   committing to the full re-ingest.
5. `npm run ingest` re-run against the live corpus.
6. `evals/compound-questions.json`: first entry's `note` field updated.
7. `evals/golden-questions.json`: two new sentinel entries (§5.3).
8. Full eval suite run, results recorded in this spec's revision history.

## Revision history

| Date | Change |
|---|---|
| 2026-07-19 | Initial spec — approved in-session after two rounds of live reproduction/systemic-check testing against the corpus. |
| 2026-07-19 | Fable review (PR #69): fixed a real inconsistency between §4.2 (claimed the new column was "inert until ingest reads it") and §4.3 (the described mechanism never actually read or wrote that column) — `index.ts`'s row-insert step now explicitly writes `embedding_text`, making it a real provenance record instead of a column that would've stayed `null` forever. Folded in three non-blocking suggestions: a pre-re-ingest dry-run validation step, an explicit note that the keyword/full-text lane is deliberately left untouched (verified it matches zero chunks for this question anyway), and an exactly-one-match assertion on the override map (breadcrumbs aren't unique across the corpus). Everything else — root cause, the Round 1/Round 2 control-question results, the pipeline mechanism fitting the real code, and the bridging sentence's football accuracy — independently verified clean. |
| 2026-07-19 | Fable follow-up review of the fix: **confirmed resolved, no remaining blockers.** One further SUGGESTION folded in — the dry-run step's wording now names the full override string explicitly (not just "the bridging text," which read literally could mean the appended sentence alone, a false-pass risk since it's packed with red-card vocabulary) and specifies matching production's `"document"`/`"query"` Voyage input types. Two cosmetic NITs fixed: §4.2 no longer claims the column is read (nothing reads it programmatically, it's a provenance record only), and §4.3 no longer references a nonexistent trigram configuration. |
| 2026-07-19 | **Independent fresh-dispatch review** (no prior context, told not to defer to earlier comments): independently re-reproduced the retrieval failure live and re-verified every load-bearing claim from scratch (root cause, corpus structure, mechanism fit, citation-integrity barriers, bridging-sentence accuracy) — all held up. Found **no BLOCKERs**, but caught 4 items neither the initial nor the resumed review round had: the dry-run's "beat 0.389" threshold lacked a safety margin (cosine similarity showed measurable run-to-run decimal variance during the reviewer's own re-check) — now requires a real margin, not a bare win; the override map should assert its text starts with the chunk's real `content`, catching hand-copy slips or future-edition drift as loud ingest failures; "single Voyage call" corrected to two (differing input types); "~hour-long full rebuild" corrected — the actual re-ingest is ~2-3 minutes at `EMBED_BATCH_SIZE=20`, that estimate was for the separately-rejected full-corpus-sweep option, not this rollout step. All four folded in. This is the first PR in this project run under the new interim "do both resumed-confirmation and fresh-dispatch on every round" practice (see `FABLE-HANDOFF.md`) — the fresh round demonstrably surfaced real findings the resumed round missed, a data point for that still-open policy question. |
| 2026-07-20 | **Task 7: full eval suite run against the live re-ingested corpus, results recorded.** `npm run eval` executed to completion (exit 0) after Task 5's live re-ingest and Task 6's fixture updates. Golden set: **32/32 recall@8 = 100.0%** (MRR 0.852) — both new Law 12 § 4 regression sentinels from Task 6 hit correctly (hit@2 and hit@1 respectively), confirming the fix didn't disturb that unrelated part of the corpus. Paraphrase set: **10/10 recall@8 = 100.0%** (MRR 0.863), unchanged. Compound set entry 1 (the red-card question, §5.2) — **the fix is confirmed working**: coverage at k=8 improved from the pre-fix baseline of **1/4** (`missed@8: Law 3 › 1 \| Law 7 › 5 \| Law 10 › 2`, measured 2026-07-14, see `.superpowers/sdd/eval-baseline-output.log`) to **2/4** (`missed@8: Law 7 › 5 \| Law 10 › 2`) — `Law 3 › 1` no longer appears in the missed list. Gate calibration: max off-topic maxSimilarity **0.493**, identical to the pre-fix baseline of 0.493 (same driving question both times — "How long is the shot clock in basketball?" — min on-topic maxSimilarity also unchanged at 0.351). The bridging text's added vocabulary produced no measurable shift in gate separability; nothing new to flag beyond the pre-existing "not separable" characterization. Full compound-set summary (n=14, informational tier, not a pass/fail gate): k=8 full coverage 3/14 (mean 0.61), k=24 full coverage 11/14 (mean 0.91) — consistent with the pre-fix multi-k pattern, no other question's coverage regressed. No BLOCKERs; all 8 deliverables from §7 complete. |
