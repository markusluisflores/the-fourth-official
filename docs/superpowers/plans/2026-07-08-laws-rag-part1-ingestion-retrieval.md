# Laws of the Game RAG — Part 1: Bootstrap, Ingestion & Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A measurable retrieval pipeline: the IFAB Laws of the Game PDF parsed, chunked by law section, embedded via Voyage, stored in Supabase pgvector, searchable via a hybrid (vector + full-text, RRF-fused) SQL function, with an eval harness reporting recall@8 and MRR against a golden question set.

**Architecture:** Offline TypeScript ingestion script writes to a single Supabase `chunks` table; a `match_chunks` SQL function does hybrid search server-side; a thin `lib/retrieval.ts` wrapper (shared later by the web app) embeds the question and calls the RPC. Spec: `docs/superpowers/specs/2026-07-08-laws-rag-design.md`. Part 2 (API route, guardrails, UI, deploy) is a separate plan written after this one ships.

**Tech Stack:** Next.js (App Router, TypeScript) scaffold · Supabase Postgres + pgvector · Voyage AI `voyage-4-lite` embeddings · Vitest · `unpdf` for PDF text extraction · `tsx` for running TS scripts.

## Global Constraints

- Node 20+; TypeScript strict mode; all new logic files under `lib/` or `scripts/`.
- Embedding model: `voyage-4-lite`, constant `EMBEDDING_MODEL` in `lib/voyage.ts`. `EMBEDDING_DIM = 1024` — **verify against a live probe in Task 2 before applying the Task 3 migration**; if the probe prints a different length, update both the constant and the migration.
- Corpus version string: `2025-26` (constant `CORPUS_VERSION` in `scripts/ingest/config.ts`).
- Retrieval: `k = 8`; RRF constant 60; relevance threshold starts at `0.35` (tuned via evals, Task 8).
- Secrets only in `.env.local` (gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`. Never in code or commits.
- Commits follow `~/.claude/standards/git-commit-standard.md`. All work on branch `feat/ingestion-retrieval`; never push to `main`.
- Risk tier: Standard (per spec §12) — per-task two-stage review + `reviewer` agent at the end.

## File Structure

```
vector-proj/
├─ app/                                 (Next.js scaffold — untouched in Part 1)
├─ lib/
│  ├─ voyage.ts                         Voyage embeddings client
│  └─ retrieval.ts                      hybrid search wrapper + relevance gate
├─ scripts/ingest/
│  ├─ config.ts                         corpus constants (version, PDF path, batch size)
│  ├─ parse.ts                          PDF → cleaned text
│  ├─ chunk.ts                          cleaned text → RawChunk[] (structure-aware)
│  └─ index.ts                          CLI: parse → chunk → embed → upsert
├─ scripts/probe-embedding-dim.ts       one-off dimension probe
├─ supabase/migrations/0001_chunks.sql  table + indexes + match_chunks RPC
├─ evals/
│  ├─ golden-questions.json             ~30 labeled questions
│  └─ run-evals.ts                      recall@8 + MRR report
├─ data/laws-2025-26.pdf                committed source PDF (with attribution in README)
└─ tests/                               Vitest unit tests mirroring lib/ and scripts/
```

---

### Task 1: Project bootstrap

**Files:**
- Create: Next.js scaffold at repo root, `vitest.config.ts`, `.env.local.example`, plus everything the `new-project` skill produces (project CLAUDE.md, CI, hooks, GitHub repo).

**Interfaces:**
- Produces: a repo where `npm test` runs Vitest, `npx tsx <file>` runs TS scripts, and `.env.local` is loaded by scripts via `dotenv`.

- [ ] **Step 1: Invoke the `new-project` skill** and complete its checklist (project CLAUDE.md, settings/hooks, GitHub repo + templates via `github-setup`, CI workflow via `cicd-standards`, Node.js quality baseline: commitlint, gitleaks, CodeQL). Also create the two agents from spec §12: global `security-reviewer` (`~/.claude/agents/security-reviewer.md`) and project `test-writer` (`.claude/agents/test-writer.md`, scoped to Vitest + this layout).

- [ ] **Step 2: Scaffold Next.js** (create-next-app refuses non-empty dirs, so scaffold in a temp dir and merge):

```powershell
npx create-next-app@latest ..\vector-proj-scaffold --typescript --eslint --app --tailwind --no-src-dir --import-alias "@/*" --use-npm
robocopy ..\vector-proj-scaffold . /E /XC /XN /XO
Remove-Item ..\vector-proj-scaffold -Recurse -Force
```

- [ ] **Step 3: Install Part-1 dependencies**

```powershell
npm install @supabase/supabase-js unpdf
npm install -D vitest tsx dotenv
```

- [ ] **Step 4: Add Vitest config and npm scripts.** Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

Add to `package.json` scripts: `"test": "vitest run"`, `"ingest": "tsx --env-file=.env.local scripts/ingest/index.ts"`, `"eval": "tsx --env-file=.env.local evals/run-evals.ts"`.

- [ ] **Step 5: Create `.env.local.example`** (committed) with empty `SUPABASE_URL=`, `SUPABASE_SERVICE_ROLE_KEY=`, `VOYAGE_API_KEY=` and confirm `.gitignore` covers `.env*.local` and `*.png` screenshots.

- [ ] **Step 6: Verify:** `npm test` exits 0 with "no test files found" (or a placeholder test passes); `npx tsx -e "console.log('ok')"` prints ok.

- [ ] **Step 7: Commit** on `main` is forbidden — create the branch first, then commit the scaffold:

```powershell
git checkout -b feat/ingestion-retrieval
git add -A; git commit -m "chore: bootstrap Next.js scaffold, Vitest, and ingest tooling"
```

---

### Task 2: Voyage embeddings client

**Files:**
- Create: `lib/voyage.ts`, `scripts/probe-embedding-dim.ts`
- Test: `tests/voyage.test.ts`

**Interfaces:**
- Produces: `embedTexts(texts: string[], inputType: "document" | "query"): Promise<number[][]>`; constants `EMBEDDING_MODEL = "voyage-4-lite"`, `EMBEDDING_DIM = 1024`.

- [ ] **Step 1: Write failing tests** in `tests/voyage.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "../lib/voyage";

function mockVoyageResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: async () => ({ data: embeddings.map((e, i) => ({ index: i, embedding: e })) }),
  } as Response;
}

describe("embedTexts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns embeddings in input order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockVoyageResponse([[1, 2], [3, 4]])));
    const result = await embedTexts(["a", "b"], "document");
    expect(result).toEqual([[1, 2], [3, 4]]);
  });

  it("returns [] for empty input without calling the API", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await embedTexts([], "query")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws with status detail on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" } as Response));
    await expect(embedTexts(["a"], "query")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `npm test` — Expected: FAIL, cannot resolve `../lib/voyage`.

- [ ] **Step 3: Implement `lib/voyage.ts`:**

```ts
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export const EMBEDDING_MODEL = "voyage-4-lite";
export const EMBEDDING_DIM = 1024; // verified by scripts/probe-embedding-dim.ts

export async function embedTexts(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
```

- [ ] **Step 4: Run tests.** Run: `npm test` — Expected: 3 PASS.

- [ ] **Step 5: Live dimension probe.** Create `scripts/probe-embedding-dim.ts`:

```ts
import { embedTexts, EMBEDDING_DIM } from "../lib/voyage";

const [v] = await embedTexts(["dimension probe"], "query");
console.log(`live dimension: ${v.length}, EMBEDDING_DIM constant: ${EMBEDDING_DIM}`);
if (v.length !== EMBEDDING_DIM) process.exitCode = 1;
```

Run: `npx tsx --env-file=.env.local scripts/probe-embedding-dim.ts` (requires a Voyage API key in `.env.local` — sign up at voyageai.com, free tier). Expected: `live dimension: 1024, EMBEDDING_DIM constant: 1024`. **If the live number differs, update `EMBEDDING_DIM` and the `vector(N)` in Task 3's migration to match, and note it in the commit body.**

- [ ] **Step 6: Commit:** `git add lib/voyage.ts tests/voyage.test.ts scripts/probe-embedding-dim.ts` then `git commit -m "feat(ingest): add Voyage embeddings client with order-preserving batch API"` (body per standard: what it does, files, intended behavior).

---

### Task 3: Supabase schema + hybrid search RPC

**Files:**
- Create: `supabase/migrations/0001_chunks.sql`

**Interfaces:**
- Produces: table `chunks(id, corpus_version, law_number, breadcrumb, content, embedding, fts)`; RPC `match_chunks(query_embedding vector, query_text text, match_count int, version text) → (id, law_number, breadcrumb, content, similarity, rrf_score)`.

- [ ] **Step 1: Create the Supabase project** (free tier) named `the-fourth-official` via the Supabase MCP (`create_project`, confirm cost = $0) or dashboard. Put `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into `.env.local`.

- [ ] **Step 2: Write `supabase/migrations/0001_chunks.sql`:**

```sql
create extension if not exists vector;

create table if not exists chunks (
  id bigint generated always as identity primary key,
  corpus_version text not null,
  law_number int not null,          -- 1..17; 0 = front matter / glossary
  breadcrumb text not null,        -- 'Law 12 › 2. Indirect free kick'
  content text not null,
  embedding vector(1024) not null, -- must equal EMBEDDING_DIM (Task 2 probe)
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (fts);
create index if not exists chunks_version_idx on chunks (corpus_version);

-- Hybrid search: vector similarity + full-text, fused with Reciprocal Rank Fusion.
create or replace function match_chunks(
  query_embedding vector(1024),
  query_text text,
  match_count int default 8,
  version text default '2025-26'
) returns table (
  id bigint,
  law_number int,
  breadcrumb text,
  content text,
  similarity double precision,
  rrf_score double precision
) language sql stable as $$
  with vec as (
    select c.id,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.corpus_version = version
    order by c.embedding <=> query_embedding
    limit 30
  ),
  kw as (
    select c.id,
           row_number() over (
             order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from chunks c
    where c.corpus_version = version
      and c.fts @@ websearch_to_tsquery('english', query_text)
    limit 30
  ),
  fused as (
    select id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score,
           coalesce(v.similarity, 0) as similarity
    from vec v full outer join kw k using (id)
  )
  select c.id, c.law_number, c.breadcrumb, c.content, f.similarity, f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
```

- [ ] **Step 3: Apply** via Supabase MCP `apply_migration` (name `chunks_and_match_rpc`) or the SQL editor.

- [ ] **Step 4: Smoke-test the RPC with seeded rows** (SQL editor / `execute_sql`):

```sql
insert into chunks (corpus_version, law_number, breadcrumb, content, embedding)
values
  ('2025-26', 11, 'Law 11 › 1. Offside position', 'A player is in an offside position if...', array_fill(0.1, array[1024])::vector),
  ('2025-26', 12, 'Law 12 › 2. Indirect free kick', 'An indirect free kick is awarded if a goalkeeper...', array_fill(0.2, array[1024])::vector);

select id, breadcrumb, similarity, rrf_score
from match_chunks(array_fill(0.1, array[1024])::vector, 'offside', 8, '2025-26');

delete from chunks where corpus_version = '2025-26';
```

Expected: two rows returned, the offside row ranked first (higher `rrf_score` — it wins both vector and keyword lanes); cleanup delete succeeds.

- [ ] **Step 5: Commit:** `git add supabase/migrations/0001_chunks.sql` then `git commit -m "feat(db): add chunks table and match_chunks hybrid-search RPC"` (migration-type body: schema change, reason, idempotent: yes via if-not-exists/or-replace, data impact: none).

---

### Task 4: PDF parsing module

**Files:**
- Create: `scripts/ingest/parse.ts`, `data/` (PDF downloaded here)
- Test: `tests/parse.test.ts`

**Interfaces:**
- Produces: `pdfToText(data: Uint8Array): Promise<string>` and pure `cleanText(raw: string): string`.

- [ ] **Step 1: Download the PDF** from the official IFAB downloads page (https://www.theifab.com/laws-of-the-game-documents/ — current-edition single-pages PDF) to `data/laws-2025-26.pdf`. Add a `data/README.md` line: source URL, download date, "© IFAB — included for non-commercial portfolio demonstration; not affiliated."

- [ ] **Step 2: Write failing tests** for the pure cleanup function in `tests/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanText } from "../scripts/ingest/parse";

describe("cleanText", () => {
  it("drops standalone page-number lines", () => {
    expect(cleanText("Some rule text\n87\nMore text")).toBe("Some rule text\nMore text");
  });

  it("drops running-header lines", () => {
    expect(cleanText("Laws of the Game 2025/26\nReal content")).toBe("Real content");
  });

  it("collapses 3+ newlines to a double newline", () => {
    expect(cleanText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("normalizes windows line endings", () => {
    expect(cleanText("a\r\nb")).toBe("a\nb");
  });
});
```

- [ ] **Step 3: Run to verify failure.** Run: `npm test` — Expected: FAIL, cannot resolve `../scripts/ingest/parse`.

- [ ] **Step 4: Implement `scripts/ingest/parse.ts`:**

```ts
import { extractText, getDocumentProxy } from "unpdf";

export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^\d{1,3}$/.test(t)) return false;                 // bare page numbers
      if (/^Laws of the Game \d{4}\/\d{2}/i.test(t)) return false; // running header
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return cleanText(text);
}
```

- [ ] **Step 5: Run tests.** Run: `npm test` — Expected: PASS. (Real-PDF quirks surface in Task 6's live run; extend `cleanText` filters + tests there as needed — that iteration is expected, not scope creep.)

- [ ] **Step 6: Commit:** `git add scripts/ingest/parse.ts tests/parse.test.ts data/README.md` (PDF too if repo policy allows binaries; otherwise document manual download) then `git commit -m "feat(ingest): add PDF text extraction with header/page-number cleanup"`.

---

### Task 5: Structure-aware chunker

**Files:**
- Create: `scripts/ingest/chunk.ts`
- Test: `tests/chunk.test.ts`

**Interfaces:**
- Consumes: cleaned text from `pdfToText` (Task 4).
- Produces: `chunkRulebook(text: string): RawChunk[]` with `interface RawChunk { lawNumber: number; breadcrumb: string; content: string }`; export `MAX_CHUNK_CHARS = 1500`.

- [ ] **Step 1: Write failing tests** in `tests/chunk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkRulebook, MAX_CHUNK_CHARS } from "../scripts/ingest/chunk";

const FIXTURE = `
LAW 11 OFFSIDE
1. Offside position
It is not an offence to be in an offside position.
2. Offside offence
A player in an offside position is penalised if involved in active play.

LAW 12 FOULS AND MISCONDUCT
1. Direct free kick
A direct free kick is awarded for careless challenges.
`.trim();

describe("chunkRulebook", () => {
  it("creates one chunk per numbered section with a breadcrumb", () => {
    const chunks = chunkRulebook(FIXTURE);
    const crumbs = chunks.map((c) => c.breadcrumb);
    expect(crumbs).toContain("Law 11 › 1. Offside position");
    expect(crumbs).toContain("Law 11 › 2. Offside offence");
    expect(crumbs).toContain("Law 12 › 1. Direct free kick");
  });

  it("tags chunks with their law number", () => {
    const chunks = chunkRulebook(FIXTURE);
    expect(chunks.find((c) => c.breadcrumb.startsWith("Law 12"))!.lawNumber).toBe(12);
  });

  it("keeps section body text in the chunk content", () => {
    const offside = chunkRulebook(FIXTURE).find((c) => c.breadcrumb === "Law 11 › 2. Offside offence")!;
    expect(offside.content).toContain("active play");
  });

  it("splits oversized sections at paragraph boundaries, keeping the breadcrumb", () => {
    const bigBody = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(60)}.`).join("\n\n");
    const text = `LAW 3 THE PLAYERS\n1. Number of players\n${bigBody}`;
    const chunks = chunkRulebook(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.every((c) => c.breadcrumb.startsWith("Law 3 › 1. Number of players"))).toBe(true);
  });

  it("puts pre-section law text into a section-0 chunk", () => {
    const text = `LAW 5 THE REFEREE\nGeneral authority statement.\n1. Powers\nThe referee has full authority.`;
    const crumbs = chunkRulebook(text).map((c) => c.breadcrumb);
    expect(crumbs).toContain("Law 5 › Introduction");
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `npm test` — Expected: FAIL, cannot resolve `../scripts/ingest/chunk`.

- [ ] **Step 3: Implement `scripts/ingest/chunk.ts`:**

```ts
export interface RawChunk {
  lawNumber: number;
  breadcrumb: string;
  content: string;
}

export const MAX_CHUNK_CHARS = 1500;

const LAW_HEADING = /^LAW\s+(\d{1,2})\s+([A-Z][A-Z ,'&-]*)$/m;
const SECTION_HEADING = /^(\d{1,2})\.\s+(\S.*)$/;

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
  return chunks;
}

function splitByLaw(text: string): { lawNumber: number; body: string }[] {
  const parts: { lawNumber: number; body: string }[] = [];
  const lines = text.split("\n");
  let current: { lawNumber: number; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(LAW_HEADING);
    if (m) {
      if (current) parts.push({ lawNumber: current.lawNumber, body: current.bodyLines.join("\n") });
      current = { lawNumber: Number(m[1]), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
    // lines before the first LAW heading (front matter) are dropped in v1
  }
  if (current) parts.push({ lawNumber: current.lawNumber, body: current.bodyLines.join("\n") });
  return parts;
}

function splitBySection(body: string): { title: string; body: string }[] {
  const sections: { title: string; bodyLines: string[] }[] = [];
  let current = { title: "Introduction", bodyLines: [] as string[] };

  for (const line of body.split("\n")) {
    const m = line.trim().match(SECTION_HEADING);
    if (m) {
      if (current.bodyLines.some((l) => l.trim() !== "")) sections.push(current);
      current = { title: `${m[1]}. ${m[2].trim()}`, bodyLines: [] };
    } else {
      current.bodyLines.push(line);
    }
  }
  if (current.bodyLines.some((l) => l.trim() !== "")) sections.push(current);

  return sections.map((s) => ({ title: s.title, body: s.bodyLines.join("\n").trim() }));
}

function splitOversize(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const pieces: string[] = [];
  let buffer = "";
  for (const para of body.split(/\n\n+/)) {
    if (buffer && buffer.length + para.length + 2 > MAX_CHUNK_CHARS) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += (buffer ? "\n\n" : "") + para;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}
```

- [ ] **Step 4: Run tests.** Run: `npm test` — Expected: all chunker tests PASS. The `LAW_HEADING` regex is calibrated to the fixture; the live PDF's heading format may differ (e.g. all-caps with numbers on separate lines) — Task 6 Step 3 validates against the real document and this regex is the expected adjustment point.

- [ ] **Step 5: Commit:** `git add scripts/ingest/chunk.ts tests/chunk.test.ts` then `git commit -m "feat(ingest): add structure-aware chunker splitting laws into section chunks"`.

---

### Task 6: Ingest CLI — wire, run for real, verify

**Files:**
- Create: `scripts/ingest/config.ts`, `scripts/ingest/index.ts`
- Modify: `scripts/ingest/parse.ts` / `chunk.ts` only if the live PDF exposes cleanup/heading gaps (extend their tests first).

**Interfaces:**
- Consumes: `pdfToText` (Task 4), `chunkRulebook` (Task 5), `embedTexts` (Task 2), `chunks` table (Task 3).
- Produces: `npm run ingest` populates Supabase for `CORPUS_VERSION = "2025-26"`.

- [ ] **Step 1: Create `scripts/ingest/config.ts`:**

```ts
export const CORPUS_VERSION = "2025-26";
export const PDF_PATH = "data/laws-2025-26.pdf";
export const EMBED_BATCH_SIZE = 64;
export const INSERT_BATCH_SIZE = 500;
```

- [ ] **Step 2: Create `scripts/ingest/index.ts`:**

```ts
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "../../lib/voyage";
import { pdfToText } from "./parse";
import { chunkRulebook } from "./chunk";
import { CORPUS_VERSION, EMBED_BATCH_SIZE, INSERT_BATCH_SIZE, PDF_PATH } from "./config";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const text = await pdfToText(new Uint8Array(await readFile(PDF_PATH)));
  const chunks = chunkRulebook(text);
  console.log(`parsed ${text.length} chars → ${chunks.length} chunks`);
  if (chunks.length < 100) throw new Error("suspiciously few chunks — check heading regexes against the live PDF");

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    embeddings.push(...(await embedTexts(batch.map((c) => c.content), "document")));
    console.log(`embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  const { error: delError } = await supabase.from("chunks").delete().eq("corpus_version", CORPUS_VERSION);
  if (delError) throw new Error(`delete failed: ${delError.message}`);

  const rows = chunks.map((c, i) => ({
    corpus_version: CORPUS_VERSION,
    law_number: c.lawNumber,
    breadcrumb: c.breadcrumb,
    content: c.content,
    embedding: embeddings[i],
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + INSERT_BATCH_SIZE));
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
  }
  console.log(`ingested ${rows.length} chunks as corpus_version=${CORPUS_VERSION}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run against the real PDF:** `npm run ingest`. Expected: several hundred chunks (the rulebook has 17 laws × ~5–10 sections plus splits). **This step will likely surface parse/chunk gaps** (odd headings, glossary formatting). For each gap: add a failing unit test to `tests/parse.test.ts` or `tests/chunk.test.ts` reproducing the live pattern, fix, re-run `npm test` and `npm run ingest`.

- [ ] **Step 4: Verify in the database** (Supabase MCP `execute_sql` or SQL editor):

```sql
select count(*) as total,
       count(distinct law_number) as laws,
       max(length(content)) as longest
from chunks where corpus_version = '2025-26';
```

Expected: `laws` = 17 (18 with law 0 front-matter if kept), `longest` ≤ 1500, total in the hundreds. Spot-check three breadcrumbs: `select breadcrumb from chunks where law_number = 11 limit 10;` — should read like `Law 11 › 1. Offside position`.

- [ ] **Step 5: Idempotency check:** run `npm run ingest` a second time; the count query must return the same total (delete-then-insert per version).

- [ ] **Step 6: Commit:** `git add scripts/ingest tests` then `git commit -m "feat(ingest): add ingest CLI; parse, chunk, embed and load the 2025-26 rulebook"` (body: include the real chunk count and any parse fixes made).

---

### Task 7: Retrieval wrapper + relevance gate

**Files:**
- Create: `lib/retrieval.ts`
- Test: `tests/retrieval.test.ts`

**Interfaces:**
- Consumes: `embedTexts` (Task 2), `match_chunks` RPC (Task 3).
- Produces (used by evals now, `/api/ask` in Part 2):
  - `interface RetrievedChunk { id: number; law_number: number; breadcrumb: string; content: string; similarity: number; rrf_score: number }`
  - `interface RetrievalResult { chunks: RetrievedChunk[]; maxSimilarity: number }`
  - `searchChunks(question: string, k?: number): Promise<RetrievalResult>` (k defaults 8)
  - `isRelevant(result: RetrievalResult): boolean`; `RELEVANCE_THRESHOLD = 0.35`

- [ ] **Step 1: Write failing tests** in `tests/retrieval.test.ts` (inject a fake RPC caller so no network is needed):

```ts
import { describe, expect, it } from "vitest";
import { isRelevant, RELEVANCE_THRESHOLD, resultFromRows, type RetrievedChunk } from "../lib/retrieval";

const row = (similarity: number): RetrievedChunk => ({
  id: 1, law_number: 11, breadcrumb: "Law 11 › 1. Offside position",
  content: "…", similarity, rrf_score: 0.03,
});

describe("relevance gate", () => {
  it("computes maxSimilarity across rows", () => {
    expect(resultFromRows([row(0.2), row(0.6)]).maxSimilarity).toBe(0.6);
  });

  it("maxSimilarity is 0 for no rows", () => {
    expect(resultFromRows([]).maxSimilarity).toBe(0);
  });

  it("gates below the threshold", () => {
    expect(isRelevant(resultFromRows([row(RELEVANCE_THRESHOLD - 0.01)]))).toBe(false);
    expect(isRelevant(resultFromRows([row(RELEVANCE_THRESHOLD)]))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `npm test` — Expected: FAIL, cannot resolve `../lib/retrieval`.

- [ ] **Step 3: Implement `lib/retrieval.ts`:**

```ts
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "./voyage";

export interface RetrievedChunk {
  id: number;
  law_number: number;
  breadcrumb: string;
  content: string;
  similarity: number;
  rrf_score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  maxSimilarity: number;
}

export const RELEVANCE_THRESHOLD = 0.35; // starting point — tuned against evals (Task 8)

export function resultFromRows(rows: RetrievedChunk[]): RetrievalResult {
  return {
    chunks: rows,
    maxSimilarity: rows.length ? Math.max(...rows.map((r) => r.similarity)) : 0,
  };
}

export function isRelevant(result: RetrievalResult): boolean {
  return result.maxSimilarity >= RELEVANCE_THRESHOLD;
}

export async function searchChunks(question: string, k = 8): Promise<RetrievalResult> {
  const [embedding] = await embedTexts([question], "query");
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: embedding,
    query_text: question,
    match_count: k,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return resultFromRows((data ?? []) as RetrievedChunk[]);
}
```

- [ ] **Step 4: Run tests.** Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Live smoke:** `npx tsx --env-file=.env.local -e "import('./lib/retrieval').then(async m => console.log((await m.searchChunks('when is a player offside')).chunks.map(c => c.breadcrumb)))"` — Expected: Law 11 breadcrumbs in the top results.

- [ ] **Step 6: Commit:** `git add lib/retrieval.ts tests/retrieval.test.ts` then `git commit -m "feat(retrieval): add hybrid-search wrapper with relevance gate"`.

---

### Task 8: Golden questions + eval harness + baseline

**Files:**
- Create: `evals/golden-questions.json`, `evals/run-evals.ts`
- Test: `tests/evals.test.ts` (scoring math only)

**Interfaces:**
- Consumes: `searchChunks` (Task 7).
- Produces: `npm run eval` printing per-question hit/rank and overall recall@8 + MRR; `scoreQuestion(chunks: {breadcrumb: string}[], expected: string[]): number` (returns 1-based rank of first hit, or 0).

- [ ] **Step 1: Draft `evals/golden-questions.json`** — 30 entries; `expected` values are breadcrumb prefixes that must appear in the top-k. Draft all 30 from the ingested breadcrumbs (query the DB for the section list), starting with these six as format anchors, then **have Markus review the full list for football correctness before the baseline run**:

```json
[
  { "question": "Can the goalkeeper pick up a deliberate back-pass from a teammate?", "expected": ["Law 12 › 2"] },
  { "question": "When is a player in an offside position?", "expected": ["Law 11 › 1"] },
  { "question": "Is a goal allowed directly from a throw-in?", "expected": ["Law 15"] },
  { "question": "How long can a goalkeeper hold the ball before releasing it?", "expected": ["Law 12 › 2"] },
  { "question": "What happens if the ball hits the referee and a team scores?", "expected": ["Law 9"] },
  { "question": "Where is a penalty kick taken from and who can touch the ball first?", "expected": ["Law 14 › 1"] }
]
```

- [ ] **Step 2: Write failing scoring tests** in `tests/evals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreQuestion } from "../evals/run-evals";

const crumbs = (...b: string[]) => b.map((breadcrumb) => ({ breadcrumb }));

describe("scoreQuestion", () => {
  it("returns the 1-based rank of the first expected match", () => {
    expect(scoreQuestion(crumbs("Law 3 › 1. Players", "Law 11 › 1. Offside position"), ["Law 11 › 1"])).toBe(2);
  });

  it("matches on prefix", () => {
    expect(scoreQuestion(crumbs("Law 15 › 2. Infringements"), ["Law 15"])).toBe(1);
  });

  it("returns 0 when nothing matches", () => {
    expect(scoreQuestion(crumbs("Law 1 › 1. Field surface"), ["Law 11 › 1"])).toBe(0);
  });

  it("honours any of several expected sections", () => {
    expect(scoreQuestion(crumbs("Law 12 › 3. Disciplinary action"), ["Law 12 › 2", "Law 12 › 3"])).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify failure.** Run: `npm test` — Expected: FAIL, cannot resolve `../evals/run-evals`.

- [ ] **Step 4: Implement `evals/run-evals.ts`:**

```ts
import { readFile } from "node:fs/promises";
import { searchChunks } from "../lib/retrieval";

interface Golden {
  question: string;
  expected: string[];
}

export function scoreQuestion(chunks: { breadcrumb: string }[], expected: string[]): number {
  const idx = chunks.findIndex((c) => expected.some((e) => c.breadcrumb.startsWith(e)));
  return idx === -1 ? 0 : idx + 1;
}

async function main() {
  const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
  let hits = 0;
  let mrrSum = 0;

  for (const g of goldens) {
    const { chunks } = await searchChunks(g.question, 8);
    const rank = scoreQuestion(chunks, g.expected);
    if (rank > 0) {
      hits += 1;
      mrrSum += 1 / rank;
    }
    console.log(`${rank > 0 ? `hit@${rank}` : "MISS "}  ${g.question}`);
  }

  console.log(`\nrecall@8: ${hits}/${goldens.length} = ${((hits / goldens.length) * 100).toFixed(1)}%`);
  console.log(`MRR:      ${(mrrSum / goldens.length).toFixed(3)}`);
}

if (process.argv[1]?.endsWith("run-evals.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Run tests, then the baseline.** Run: `npm test` — Expected: PASS. Then `npm run eval` — record the baseline recall@8 and MRR in the commit body and in `docs/project-reviewer.md` (the "number you quote in interviews"). Investigate MISSes: legitimately mislabeled goldens get fixed; genuine retrieval misses stay as the improvement backlog. Use per-question similarity output to sanity-check `RELEVANCE_THRESHOLD` (off-topic probe: run a cricket question manually and confirm it gates).

- [ ] **Step 6: Commit:** `git add evals tests/evals.test.ts` then `git commit -m "feat(evals): add golden-question retrieval harness; baseline recall@8 <N>%"`.

---

### Task 9: Wrap-up — review gates and PR

- [ ] **Step 1:** Dispatch the `reviewer` agent on the branch diff with the spec + this plan (Standard tier).
- [ ] **Step 2:** Run `/security-review` on the diff (secrets handling, service-role key usage in scripts only).
- [ ] **Step 3:** Invoke the `pre-pr-review` skill (checklist, impact check, Definition of Done), then `commit-commands:commit-push-pr` to open the PR.
- [ ] **Step 4:** After merge: update `docs/project-reviewer.md` with the measured baseline + any live-PDF chunking lessons (capture mode), and note Part 2 planning as the next session's start.

---

## Self-Review (performed at write time)

- **Spec coverage (Part 1 scope):** §2 corpus (T4 download/attribution), §3 stack (T1), §5 ingestion incl. data model (T3–T6), §6 steps 2–4 retrieval + gate (T7), §10 unit tests (every task) + eval harness (T8), §12 bootstrap + agents (T1). Deliberately deferred to Part 2: §6 step 5–6 generation/citations, §7 UI, §8 guardrails, §9 runtime failure handling (the gate exists; API error UX is Part 2).
- **Placeholders:** none — every code step has full code; the two "adjust against the live PDF" notes are explicit test-first iteration loops with defined locations, not deferred work.
- **Type consistency:** `RawChunk` (T5) → insert mapping (T6) → `chunks` columns (T3) → `RetrievedChunk` (T7) → `scoreQuestion` input (T8) all align; `EMBEDDING_DIM`/`vector(1024)` cross-checked via T2 probe; `embedTexts` signature identical in T2/T6/T7.
