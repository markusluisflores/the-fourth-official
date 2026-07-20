# Law 3 § 1 Retrieval Gap Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #64 so that retrieval surfaces `Law 3 › 1. Number of players`
for questions like "What happens if everyone on a team gets a red card?",
without changing a single character of what's displayed to users as the
cited passage.

**Architecture:** Add a nullable `embedding_text` column to `chunks`. A
breadcrumb-keyed override map in the ingest pipeline supplies enriched text
for exactly one row (Law 3 § 1); that text feeds the Voyage embedding call
instead of the row's `content`, and also gets stored in the new column as a
provenance record. `content` — what's shown in citations — is never touched.

**Tech Stack:** TypeScript, `tsx` (ingest script runner), Supabase Postgres
(`chunks` table), Voyage `voyage-4-lite` embeddings, Vitest.

## Global Constraints

- Corpus has exactly 118 chunks, `corpus_version = '2025-26'` (verify this
  doesn't change unexpectedly — `assertCompleteLawSet` already guards law
  number completeness, not row count).
- `Law 3 › 1. Number of players` is a single row (confirmed live, id 258 as
  of 2026-07-19, 740 chars) — no multi-piece splitting to account for.
- Never edit `content` for any chunk. The enrichment lives only in
  `embedding_text` and is never read by any query or shown to a user.
- Voyage free tier: 3 requests/minute, no payment method on file. Any script
  making more than one Voyage call needs a delay between calls (see
  `EMBED_BATCH_SIZE`'s existing 21-second gap in `scripts/ingest/index.ts`
  for precedent) or it 429s.
- Migrations apply to the live Supabase project `the-fourth-official`
  (`moybkceeltzwnyiaasys`) via the Supabase MCP `apply_migration` tool, with
  the SQL file committed in the same commit as the code that uses it.
- Full spec: `docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md`
  (approved, merged, two rounds of Fable review — do not deviate from its
  approach without a plan revision on its own docs branch, per this
  project's spec/plan-revision rule).

---

### Task 1: Migration — add `embedding_text` column

**Files:**
- Create: `supabase/migrations/0006_chunks_embedding_text.sql`

**Interfaces:**
- Produces: a `chunks.embedding_text` column (nullable `text`), consumed by
  Task 3.

- [ ] **Step 1: Write the migration**

```sql
-- 0006: nullable embedding-only text override, used to give a chunk a
-- richer search fingerprint without changing what's displayed as its
-- citation (content stays untouched). Populated for at most a handful of
-- rows — most stay null forever. See
-- docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md.
alter table chunks add column embedding_text text;
```

- [ ] **Step 2: Apply to the live project**

Supabase MCP `apply_migration`, project `moybkceeltzwnyiaasys`, name
`chunks_embedding_text`, SQL above. Expected: success.

- [ ] **Step 3: Verify live**

Supabase MCP `execute_sql`, project `moybkceeltzwnyiaasys`:

```sql
select column_name, is_nullable, data_type
from information_schema.columns
where table_name = 'chunks' and column_name = 'embedding_text';
```

Expected: one row, `is_nullable = 'YES'`, `data_type = 'text'`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0006_chunks_embedding_text.sql
git commit -m "feat: add nullable embedding_text column to chunks"
```

---

### Task 2: `chunk.ts` — override map and `RawChunk` field

**Files:**
- Modify: `scripts/ingest/chunk.ts`
- Test: `tests/chunk.test.ts`

**Interfaces:**
- Consumes: nothing new — `RawChunk` and `chunkRulebook` already exist
  (`scripts/ingest/chunk.ts:3-7,37-50`).
- Produces: `RawChunk.embeddingText?: string`, and `chunkRulebook`'s output
  now sets it for the one matching chunk. `applyEmbeddingTextOverrides`
  (new exported pure function) — consumed by Task 3 indirectly via
  `chunkRulebook`, and directly testable on its own.

- [ ] **Step 1: Write the failing tests**

Add to `tests/chunk.test.ts` (new `describe` block, after the existing
`assertCompleteLawSet` block):

```ts
describe("applyEmbeddingTextOverrides", () => {
  it("sets embeddingText on the one chunk matching an override breadcrumb", () => {
    const chunks: RawChunk[] = [
      { lawNumber: 3, breadcrumb: "Law 3 › 1. Number of players", content: "real text" },
      { lawNumber: 3, breadcrumb: "Law 3 › 2. Number of substitutions", content: "other text" },
    ];
    const result = applyEmbeddingTextOverrides(chunks, {
      "Law 3 › 1. Number of players": "real text plus extra hint",
    });
    expect(result.find((c) => c.breadcrumb === "Law 3 › 1. Number of players")!.embeddingText).toBe(
      "real text plus extra hint",
    );
    expect(
      result.find((c) => c.breadcrumb === "Law 3 › 2. Number of substitutions")!.embeddingText,
    ).toBeUndefined();
  });

  it("throws if an override breadcrumb matches zero chunks", () => {
    const chunks: RawChunk[] = [
      { lawNumber: 3, breadcrumb: "Law 3 › 2. Number of substitutions", content: "other text" },
    ];
    expect(() =>
      applyEmbeddingTextOverrides(chunks, {
        "Law 3 › 1. Number of players": "real text plus extra hint",
      }),
    ).toThrow(/matched 0 chunks/);
  });

  it("throws if an override breadcrumb matches more than one chunk", () => {
    const chunks: RawChunk[] = [
      { lawNumber: 3, breadcrumb: "Law 3 › 1. Number of players", content: "real text" },
      { lawNumber: 3, breadcrumb: "Law 3 › 1. Number of players", content: "real text part 2" },
    ];
    expect(() =>
      applyEmbeddingTextOverrides(chunks, {
        "Law 3 › 1. Number of players": "real text plus extra hint",
      }),
    ).toThrow(/matched 2 chunks/);
  });

  it("throws if the override text does not start with the chunk's real content", () => {
    const chunks: RawChunk[] = [
      { lawNumber: 3, breadcrumb: "Law 3 › 1. Number of players", content: "real text" },
    ];
    expect(() =>
      applyEmbeddingTextOverrides(chunks, {
        "Law 3 › 1. Number of players": "totally different text",
      }),
    ).toThrow(/does not start with the chunk's real content/);
  });
});
```

Add `applyEmbeddingTextOverrides` to the import list at the top of
`tests/chunk.test.ts`:

```ts
import {
  applyEmbeddingTextOverrides,
  assertCompleteLawSet,
  chunkRulebook,
  MAX_CHUNK_CHARS,
  type RawChunk,
} from "../scripts/ingest/chunk";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chunk.test.ts`
Expected: FAIL — `applyEmbeddingTextOverrides` is not exported (does not
exist yet).

- [ ] **Step 3: Implement**

In `scripts/ingest/chunk.ts`, change the `RawChunk` interface and add the
new function + override map. Full replacement of the top of the file
through `chunkRulebook`:

```ts
import { isLawDivider } from "./parse";

export interface RawChunk {
  lawNumber: number;
  breadcrumb: string;
  content: string;
  embeddingText?: string;
}

export const MAX_CHUNK_CHARS = 1500;

// Chapter dividers in the live PDF (extracted via unpdf) render as "Law" and the bare
// chapter number on their own consecutive lines — the spelled-out title is a stylized
// graphic and isn't extractable as plain text, unlike the synthetic "LAW 11 OFFSIDE"
// single-line fixture this regex originally targeted. See parse.ts's isLawDivider for
// the shared divider-detection predicate, also used by truncateBackMatter's boundary
// logic.
const SECTION_HEADING = /^(\d{1,2})\.\s+(\S.*)$/;

export const EXPECTED_LAW_NUMBERS = Array.from({ length: 17 }, (_, i) => i + 1);

// Breadcrumb-keyed overrides: enriched text fed to the embedding step instead of the
// chunk's real content, so its search fingerprint can be nudged closer to phrasings the
// bare rulebook text doesn't share vocabulary with. The chunk's displayed content is
// never touched — only what gets embedded changes. Each entry must be the FULL
// replacement text (original content + addition), not a suffix to concatenate, so
// there's no string-building logic to get wrong. See
// docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md for why each
// entry exists and how its wording was chosen.
export const EMBEDDING_TEXT_OVERRIDES: Record<string, string> = {
  "Law 3 › 1. Number of players":
    "A match is played by two teams, each with a maximum of eleven players;\n" +
    "one must be the goalkeeper. A match may not start or continue if either team\n" +
    "has fewer than seven players.\n" +
    "If a team has fewer than seven players because one or more players has\n" +
    "deliberately left the field of play, the referee is not obliged to stop play and\n" +
    "the advantage may be played, but the match must not resume after the ball has\n" +
    "gone out of play if a team does not have the minimum number of seven players.\n" +
    "If the competition rules state that all players and substitutes must be named\n" +
    "before kick-off and a team starts a match with fewer than eleven players,\n" +
    "only the players and substitutes named on the team list may take part in the\n" +
    "match upon their arrival.\n" +
    "This rule applies regardless of the reason a team has fewer than seven players, " +
    "including when players are sent off — for example after receiving a red card — " +
    "and the team's number of players falls below the seven-player minimum.",
};

// Applies EMBEDDING_TEXT_OVERRIDES to a chunk list, setting embeddingText on the one
// matching chunk per breadcrumb key. Fails loudly (never silently) on a breadcrumb that
// matches zero or more than one chunk (breadcrumbs are not guaranteed unique — see
// splitOversize, which already produces multiple chunks sharing one breadcrumb for
// oversized sections), and on an override value that doesn't start with the chunk's
// real content (guards against a hand-copy slip when the override was written, or
// future corpus drift if the source PDF is ever replaced with a newer edition).
export function applyEmbeddingTextOverrides(
  chunks: RawChunk[],
  overrides: Record<string, string> = EMBEDDING_TEXT_OVERRIDES,
): RawChunk[] {
  for (const [breadcrumb, embeddingText] of Object.entries(overrides)) {
    const matches = chunks.filter((c) => c.breadcrumb === breadcrumb);
    if (matches.length !== 1) {
      throw new Error(
        `embedding-text override for "${breadcrumb}" matched ${matches.length} chunks, expected exactly 1`,
      );
    }
    if (!embeddingText.startsWith(matches[0].content)) {
      throw new Error(
        `embedding-text override for "${breadcrumb}" does not start with the chunk's real content`,
      );
    }
  }
  return chunks.map((c) =>
    c.breadcrumb in overrides ? { ...c, embeddingText: overrides[c.breadcrumb] } : c,
  );
}
```

Then update `chunkRulebook` to apply the overrides before returning (last
line of the function):

```ts
export function chunkRulebook(text: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const lawParts = splitByLaw(text);

  for (const { lawNumber, body } of lawParts) {
    for (const section of splitBySection(body)) {
      const crumb = `Law ${lawNumber} › ${section.title}`;
      for (const piece of splitOversize(section.body)) {
        chunks.push({ lawNumber, breadcrumb: crumb, content: piece });
      }
    }
  }
  return applyEmbeddingTextOverrides(chunks);
}
```

(Everything below `chunkRulebook` in the file — `splitByLaw`,
`splitBySection`, `splitOversize`, `packUnits` — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chunk.test.ts`
Expected: PASS, all tests including the pre-existing ones (the override
application at the end of `chunkRulebook` must not break any existing
`chunkRulebook`/`assertCompleteLawSet` test — none of their fixtures use the
`Law 3 › 1. Number of players` breadcrumb, so the override map is a no-op
for all of them).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest/chunk.ts tests/chunk.test.ts
git commit -m "feat: add embedding-text override for Law 3 § 1 (issue #64)"
```

---

### Task 3: `index.ts` — use and persist `embeddingText`

**Files:**
- Modify: `scripts/ingest/index.ts`

**Interfaces:**
- Consumes: `RawChunk.embeddingText?: string` (Task 2).
- Produces: `chunks.embedding_text` populated on ingest (Task 1's column).

This script is not unit-tested today (no `index.test.ts` exists — it's an
operational script that calls live Voyage + Supabase and is verified by
running it, same as every prior ingest change in this project). This task's
own verification is the dry-run in Task 4 and the full re-ingest in Task 5,
not a Vitest run.

- [ ] **Step 1: Modify the embedding step**

In `scripts/ingest/index.ts`, change the embedding-step `batch.map` call
(currently `batch.map((c) => c.content)`):

```ts
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 21_000));
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    embeddings.push(
      ...(await embedTexts(
        batch.map((c) => c.embeddingText ?? c.content),
        "document",
      )),
    );
    console.log(`embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }
```

- [ ] **Step 2: Modify the row-insert step**

Change the `rows` map (currently missing `embedding_text`):

```ts
  const rows = chunks.map((c, i) => ({
    corpus_version: CORPUS_VERSION,
    law_number: c.lawNumber,
    breadcrumb: c.breadcrumb,
    content: c.content,
    embedding_text: c.embeddingText ?? null,
    embedding: embeddings[i],
  }));
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest/index.ts
git commit -m "feat: embed and persist embeddingText override during ingest"
```

---

### Task 4: Dry-run validation (before touching production data)

**Files:**
- Create (temporary, not committed): a throwaway script, e.g.
  `_tmp-dry-run-validate.ts` in the repo root (same pattern used during this
  fix's brainstorming — write it, run it, delete it before any commit; add
  it to no commit, verify `git status` is clean of it afterward).

**Interfaces:**
- Consumes: `EMBEDDING_TEXT_OVERRIDES` (Task 2, imported from
  `scripts/ingest/chunk.ts`), `embedTexts` (`lib/voyage.ts`, existing).
- Produces: a pass/fail signal gating Task 5 — do not proceed to Task 5 if
  this fails.

- [ ] **Step 1: Write the dry-run script**

```ts
// TEMPORARY — do not commit. Deleted at the end of this task.
import { embedTexts } from "./lib/voyage";
import { EMBEDDING_TEXT_OVERRIDES } from "./scripts/ingest/chunk";

const QUESTION = "What happens if everyone on a team gets a red card?";
const OVERRIDE_TEXT = EMBEDDING_TEXT_OVERRIDES["Law 3 › 1. Number of players"];
const CURRENT_8TH_PLACE_SIMILARITY = 0.389; // measured live, issue #64 / spec §1

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}

async function main() {
  const [overrideEmbedding] = await embedTexts([OVERRIDE_TEXT], "document");
  await new Promise((resolve) => setTimeout(resolve, 21_000)); // stay under 3 RPM
  const [questionEmbedding] = await embedTexts([QUESTION], "query");

  const similarity = cosineSimilarity(overrideEmbedding, questionEmbedding);
  const margin = similarity - CURRENT_8TH_PLACE_SIMILARITY;
  console.log(`override-text vs question similarity: ${similarity.toFixed(4)}`);
  console.log(`margin over current 8th-place (${CURRENT_8TH_PLACE_SIMILARITY}): ${margin.toFixed(4)}`);
  if (margin < 0.02) {
    console.error(
      `FAIL: margin ${margin.toFixed(4)} is too thin (< 0.02) — cosine similarity has ` +
        `observed third-decimal-place run-to-run variance, and every chunk gets ` +
        `re-embedded on a full re-ingest. Revise the override text before proceeding.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("PASS: margin is large enough to proceed to the full re-ingest.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run it**

Run: `NODE_OPTIONS="--experimental-websocket --conditions=react-server" npx tsx --env-file=.env.local _tmp-dry-run-validate.ts`

Expected: `PASS: margin is large enough to proceed to the full re-ingest.`
printed, with the actual similarity and margin values logged above it.

**If it FAILS:** stop here. Do not proceed to Task 5. Revise the bridging
sentence in `EMBEDDING_TEXT_OVERRIDES` (Task 2) — this is a plan/spec-level
finding (the chosen wording doesn't work), not a bug to patch silently; per
this project's rules, escalate rather than iterate the wording ad hoc
without recording why the first version didn't work.

- [ ] **Step 3: Delete the temporary script and confirm clean**

```bash
rm _tmp-dry-run-validate.ts
git status --short
```

Expected: `_tmp-dry-run-validate.ts` does not appear in `git status` output
(it was never staged/committed — this step just confirms the working tree
is clean before continuing).

---

### Task 5: Full re-ingest against the live corpus

**Files:** none (operational step — runs the code from Tasks 2 and 3
against real services).

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: live `chunks` table state with the Law 3 § 1 row's `embedding`
  computed from its override text and `embedding_text` populated.

- [ ] **Step 1: Run the ingest**

Run: `npm run ingest`

Expected: completes with `ingested 118 chunks as corpus_version=2025-26` (or
current chunk count if it has changed — investigate if it's not close to
118, per the existing `chunks.length < 100` guard in `index.ts`). Takes a
few minutes under the `EMBED_BATCH_SIZE=20` / 21-second-per-batch pacing —
not the hour-plus estimate that applies to the separately-rejected
full-corpus-sweep option (spec §4.3, corrected in review).

- [ ] **Step 2: Verify the one overridden row directly**

Supabase MCP `execute_sql`, project `moybkceeltzwnyiaasys`:

```sql
select id, breadcrumb, length(content) as content_len,
       length(embedding_text) as embedding_text_len
from chunks
where corpus_version = '2025-26' and breadcrumb = 'Law 3 › 1. Number of players';
```

Expected: one row, `embedding_text_len` > `content_len` (the override is
strictly longer than the original — it's the original plus the appended
sentence), `content_len` = 740 (unchanged from before this fix).

- [ ] **Step 3: Verify the fix directly against retrieval**

Write a throwaway check (same pattern as Task 4 — do not commit):

```ts
// TEMPORARY — do not commit. Deleted at the end of this step.
import { searchChunks } from "./lib/retrieval";

async function main() {
  const result = await searchChunks("What happens if everyone on a team gets a red card?", 8);
  const hasLaw3s1 = result.chunks.some((c) => c.breadcrumb === "Law 3 › 1. Number of players");
  console.log(`Law 3§1 present in top-8? ${hasLaw3s1}`);
  console.log(result.chunks.map((c) => `[${c.similarity.toFixed(3)}] ${c.breadcrumb}`).join(" | "));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

Run: `NODE_OPTIONS="--experimental-websocket --conditions=react-server" npx tsx --env-file=.env.local _tmp-verify-fix.ts`

Expected: `Law 3§1 present in top-8? true`. If `false`, STOP — the fix
didn't work as designed; this is a plan/spec-level finding, escalate rather
than iterating the override text ad hoc.

Then delete: `rm _tmp-verify-fix.ts && git status --short` (confirm clean).

No commit for this task (nothing changed in the repo — this is a live-data
operation plus verification).

---

### Task 6: Update eval regression fixtures

**Files:**
- Modify: `evals/compound-questions.json`
- Modify: `evals/golden-questions.json`

**Interfaces:** none — pure data file edits.

- [ ] **Step 1: Update the stale note on `compound-questions.json`'s first entry**

Current (line 5 as of this plan):
```json
    "note": "The known Part 2b failure: fewer-than-7 abandonment vs penalty-shoot-out confusion. Full answer needs minimum players, abandoned-match consequence, how winners are determined, and when shoot-outs apply."
```

Replace with:
```json
    "note": "Fixed 2026-07-19 (issue #64): Law 3 › 1 previously never surfaced for this phrasing — a targeted embedding-text override closed the gap (docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md). Retained as a compound question: full answer still needs minimum players, abandoned-match consequence, how winners are determined, and when shoot-outs apply."
```

- [ ] **Step 2: Add two sentinel entries to `golden-questions.json`**

Append to the array (before the closing `]`), matching the file's existing
one-line-per-entry style:

```json
  { "question": "A player who's already on a yellow card dives to win a free kick — does that automatically mean a second yellow and being sent off?", "expected": ["Law 12 › 4"] },
  { "question": "If a foul earns a penalty kick, does that let the referee give only a yellow card instead of a straight red for denying a goalscoring opportunity?", "expected": ["Law 12 › 4"] }
```

- [ ] **Step 3: Validate both files are valid JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('evals/compound-questions.json','utf8')); console.log('compound-questions.json OK')"
node -e "JSON.parse(require('fs').readFileSync('evals/golden-questions.json','utf8')); console.log('golden-questions.json OK')"
```
Expected: both print `OK`.

- [ ] **Step 4: Commit**

```bash
git add evals/compound-questions.json evals/golden-questions.json
git commit -m "test: update issue #64 eval fixtures after the retrieval fix"
```

---

### Task 7: Full eval suite run and results recorded

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md`
  (revision history table only)

**Interfaces:** none.

- [ ] **Step 1: Run the full eval suite**

Run: `npm run eval`

Expected: completes (exit 0). Golden set: 32/32 recall@8 (30 original + 2
new sentinels from Task 6) — if either new sentinel misses, STOP and
investigate before proceeding (per spec §5.4, this would mean the fix
disturbed an unrelated part of the corpus). Paraphrase set: 10/10, unchanged.
Compound set: the first entry ("What happens if everyone on a team gets a
red card?") should now show `Law 3 › 1` present in its per-question
breadcrumb line at k=8 (previously always missing) — check the console
output's `missed@8` line for this question no longer lists `Law 3 › 1`.

- [ ] **Step 2: Record the result in the spec's revision history**

Add a new row to the revision history table in
`docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md`,
with the actual measured before/after coverage for the first
`compound-questions.json` entry (fill in real numbers from Step 1's output,
not placeholder text) and confirmation that all 32 golden-set questions and
10 paraphrase-set questions passed.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md
git commit -m "docs: record post-fix eval results for issue #64"
```

---

## Self-Review Notes

- **Spec coverage:** all 8 deliverables from spec §7 map to a task —
  migration (Task 1), override map (Task 2), embed+persist (Task 3),
  dry-run (Task 4), re-ingest (Task 5), eval fixture updates (Task 6, both
  files), full eval run + recording (Task 7).
- **No placeholders:** every step has literal code, exact commands, and
  exact expected output — dry-run margin threshold, migration name, column
  types, and test assertions are all concrete values, not TBDs.
- **Type consistency:** `RawChunk.embeddingText?: string` (Task 2) is the
  exact name used in Task 3's `c.embeddingText ?? c.content` and
  `c.embeddingText ?? null`. `applyEmbeddingTextOverrides` and
  `EMBEDDING_TEXT_OVERRIDES` are exported with those exact names from
  `scripts/ingest/chunk.ts` in Task 2 and referenced with those names in
  Task 4's dry-run script.
