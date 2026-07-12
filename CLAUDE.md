@AGENTS.md

# the-fourth-official

A football (soccer) rules Q&A RAG (Retrieval-Augmented Generation) system built over the
IFAB **Laws of the Game** — the single official rulebook of football worldwide. A visitor
asks a rules question in plain English; the app retrieves the relevant rulebook passages and
has Claude answer strictly from them, with structured citations back to the exact law
sections. Portfolio project for Claude Code-related roles — see "Docs" below for the full
design story and interview talking points.

Global workflow rules (feature workflow, design process, mandatory skills, conventions) live
in `C:\Users\Miko\.claude\CLAUDE.md` and apply here automatically. This file adds only what's
specific to this project.

## Docs

- Design spec: `docs/superpowers/specs/2026-07-08-laws-rag-design.md`
- Part 1 implementation plan (bootstrap, ingestion, retrieval, evals): `docs/superpowers/plans/2026-07-08-laws-rag-part1-ingestion-retrieval.md`
- Interview / project-reviewer guide: `docs/project-reviewer.md`
- Session journal: `docs/journal/`

## Stack

Next.js (App Router, TypeScript, strict mode) · Supabase Postgres + pgvector · Voyage AI
`voyage-4-lite` embeddings · Claude Haiku 4.5 for generation · Vitest for unit tests ·
`tsx` for running standalone TypeScript scripts · Railway for hosting.

## Project phases

- **Part 1 (this phase):** ingestion pipeline + hybrid retrieval + eval harness. No UI, no
  API route, no guardrails yet.
- **Part 2 (future):** `/api/ask` route, password gate, rate limiting/spend ceiling, citations
  UI, deploy.

## File layout

```
app/                       Next.js App Router
  api/                       ask/ (question answering) and session/ (auth state)
  layout.tsx / page.tsx      (bootstrap, deferred to Part 2b)
middleware.ts              NextRequest auth validation + session check
lib/                       shared logic — voyage.ts, retrieval.ts, answer.ts, auth.ts
scripts/ingest/            offline ingestion CLI — config, parse, chunk, index
scripts/probe-embedding-dim.ts  one-off Voyage dimension probe
supabase/migrations/       schema + RPC + RLS
  0001_init.sql            create extension, tables, match_chunks RPC
  0002_match_chunks_similarity_fix.sql  boundary case fix
  0003_chunks_rls.sql      RLS policies (deny all, server role excepted)
  0004_usage_counters.sql  counter table + trigger, used by guardrails
evals/                     golden-questions.json + run-evals.ts (recall@8, MRR)
data/                      committed source PDF + attribution README
tests/                     Vitest unit tests mirroring lib/ and scripts/
```

All new logic files go under `lib/` or `scripts/`, never directly in `app/`, per the plan's
Global Constraints.

## Commands

- `npm test` — run Vitest (`tests/**/*.test.ts`)
- `npm run lint` — ESLint
- `npx tsc --noEmit` — full-project type check
- `npm run dev` / `npm run build` — Next.js dev server / production build
- `npm run ingest` — run the ingestion CLI against `.env.local` (parses the PDF, chunks,
  embeds, upserts into Supabase). Uses `--conditions=react-server` to allow `server-only`
  imports: the `server-only` package is harmless in Node scripts (resolves to a no-op via
  the React server condition) but would fail without this flag.
- `npm run eval` — run the retrieval eval harness against `.env.local`. Same `--conditions=react-server`
  requirement as `ingest`.

## Secrets

**Development** (`.env.local`, gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`

**Production** (Railway env vars): all of the above, plus `ANTHROPIC_API_KEY` (required for
answer generation), `ANTHROPIC_MODEL` (optional; defaults to `claude-haiku-4.5-20250109` if
unset), `DEMO_PASSWORD` (required; protect the public `/api/ask` route with a simple password),
`SESSION_SECRET` (required; a long random string for signing session cookies).

All secrets: never in code, prompts, or commits. `.env.local.example` documents the required keys
with empty values. `gitleaks` runs as a pre-commit hook and GitHub push protection is a second layer.

## Risk tiers (per spec §12)

- **Mandatory:** guardrail/auth code (password gate, rate limiting, spend ceiling — Part 2).
- **Standard:** ingestion, retrieval, UI.
- **Routine:** copy/config.

## CI Runbook

- `ci.yml` — Vitest tests (`test` job) + ESLint/`tsc --noEmit`/`npm audit`/Next.js build
  (`lint-and-build` job) + `gitleaks` secret scan (`secret-scan` job). No secrets required.
  Manual trigger: `gh workflow run ci.yml`.
- `codeql.yml` — CodeQL SAST on `javascript-typescript`, on every PR, push to `main`, and a
  weekly schedule. No secrets required (uses the built-in `GITHUB_TOKEN`). Manual trigger:
  `gh workflow run codeql.yml`.

## Agents

- `test-writer` (`.claude/agents/test-writer.md`) — writes Vitest tests from a spec/plan in a
  separate context, scoped to this repo's `lib/`/`scripts/`/`tests/` layout.
- `security-reviewer` (global, `~/.claude/agents/security-reviewer.md`) — dispatched for
  Mandatory-tier work (Part 2 guardrail/auth code) alongside `/security-review`.
