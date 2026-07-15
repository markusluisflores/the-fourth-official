# The Fourth Official

Football rules Q&A grounded in the IFAB **Laws of the Game** — ask a question in
plain English, get a referee-neutral ruling that cites the exact law passages it
rests on, streamed live, with a "How this answer was built" panel showing every
retrieved passage, its similarity score, and whether the answer actually used it.

Built as a portfolio RAG project: hybrid retrieval (pgvector + Postgres full-text,
fused with RRF) over the official rulebook, Claude with native citations for
generation, and measured evals (recall@8, MRR, gate calibration) behind every
tuning decision.

## Stack

Next.js (App Router) · Supabase Postgres + pgvector · Voyage `voyage-4-lite`
embeddings · Claude Haiku 4.5 with `citations: {enabled: true}` · Vitest · Railway.

## How it works

1. **Ingestion (offline):** the official PDF is parsed, cleaned, and chunked along
   the rulebook's own structure (law → section), embedded, and upserted into
   Supabase (`npm run ingest`).
2. **Retrieval:** one SQL RPC runs vector + keyword search and merges rankings
   with Reciprocal Rank Fusion; a calibrated relevance gate abstains on off-topic
   questions before any generation spend.
3. **Generation:** retrieved chunks go to Claude as document blocks with native
   citations — the answer streams back with structured claim-to-passage links,
   not prompt-glued markers.
4. **Guardrails:** shared-password gate, per-visitor and global daily budgets
   (atomic Postgres counters), 300-char input cap, deny-all RLS with server-only
   data access (ADR-001).

## Known limitations

- Compound questions spanning several laws at once (e.g. "what happens if
  everyone gets a red card?") can exceed what single-pass k=8 retrieval
  covers: answers cite accurately what was retrieved but may not assemble
  every relevant law. Measured honestly by the eval harness's compound tier
  (`npm run eval`); design + baseline:
  `docs/superpowers/specs/2026-07-14-compound-question-eval-design.md`.

## Development

`npm run dev` — needs `.env.local` (see `.env.local.example`). Tests: `npm test`.
Retrieval evals: `npm run eval`. Full docs: `docs/` (design specs, plans, ADRs,
session journal, interview guide).
