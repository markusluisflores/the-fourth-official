# Laws of the Game RAG — Design Spec

**Date:** 2026-07-08
**Status:** Approved pending final user review
**Project:** vector-proj (working title: "Laws of the Game RAG" — product name TBD at bootstrap)

## 1. What we're building

A web app that settles football (soccer) rules arguments by quoting the actual rulebook. A user asks a rules question in plain English ("Can a goalkeeper pick up a deliberate back-pass?"); the app finds the relevant passages in the IFAB **Laws of the Game** — the single official rulebook of football worldwide — and has Claude write a plain-English answer with the exact law sections quoted as citations.

This is a RAG (Retrieval-Augmented Generation) system: **retrieval** finds the rulebook passages whose meaning matches the question; **generation** has an LLM answer *only from those passages*, with citations so the user can verify nothing was made up.

### Goals

1. **Portfolio artifact** for Claude Code-related roles: a deployed, working demo plus a codebase that demonstrates the full RAG skillset (chunking, embeddings, vector + hybrid search, citations, retrieval evals).
2. **Interview material**: every design decision below is a deliberate, defensible choice (recorded here and in `docs/project-reviewer.md`).
3. **Learning vehicle**: this is Markus's first vector/embeddings project; the code and docs stay plain-language.

### Explicitly not goals (v1)

- User accounts or per-user history
- Conversation memory (each question is standalone)
- Multiple rulebook editions live in the UI (schema supports it; UI shows one)
- Non-English questions/answers
- FM AI Scout (see §10)

## 2. Corpus decision

**Corpus:** IFAB Laws of the Game, current edition (~230-page PDF, published free at theifab.com; updated yearly).

**Why this corpus:**
- Bounded and authoritative — one official document governs the entire sport, ideal for measurable retrieval quality.
- Question-rich domain: people genuinely argue about football rules; demo questions write themselves.
- No well-known existing assistant over the rulebook (unlike e.g. the Claude docs, which have an official "Ask AI").
- Personally interesting to the author (football), which keeps the demo genuine.

**Licensing note:** the Laws of the Game are distributed free by IFAB but are not Creative Commons. Non-commercial portfolio use with attribution; the README will carry an attribution + non-affiliation disclaimer.

**Alternatives considered:** Claude Code docs (rejected: official bot already exists; differentiation burden), Football Manager dataset (structured stats, not documents — preserved as v2, §10), game wiki / Open Music Theory (viable, less personal pull).

## 3. Stack

| Piece | Choice | Why |
|---|---|---|
| Web app | Next.js (App Router, TypeScript) | Familiar from chat-app; learning budget goes to RAG concepts, not a new stack. TS is the native language of the Claude Code ecosystem. |
| Database + vector store | Supabase Postgres with **pgvector** | One database does relational + vector + full-text; industry-standard extension; enables hybrid search in a single SQL function. |
| Embeddings | **Voyage AI** `voyage-4-lite` | Anthropic's recommended embeddings partner (Anthropic doesn't make embedding models). 200M-token free tier vs ~150K-token corpus → effectively free. |
| Answer generation | **Claude Haiku 4.5** (`claude-haiku-4-5`) | ~0.4¢/question; answers are grounded in retrieved text so top-tier reasoning isn't required. Model ID is an env var — swappable to Sonnet/Opus in one line. |
| Hosting | Railway | Same platform as chat-app; known deploy path. |
| Tests | Vitest + a custom retrieval-eval script | Matches existing portfolio conventions. |

**Rejected approaches:** Python/FastAPI backend (new language + new concepts simultaneously = stall risk; concepts transfer 1:1 from TS); no-database in-memory search (right-sized for ~1K chunks but skips the vector-DB experience this project exists to build — kept as an interview talking point instead).

## 4. Architecture

Two halves, running at different times:

```
 OFFLINE (run per rulebook edition)               ONLINE (every question)
┌──────────────────────────────────┐    ┌──────────────────────────────────────┐
│  Ingestion script (TS, local)    │    │  Next.js app on Railway              │
│  1. Download IFAB PDF            │    │  Browser ──► POST /api/ask           │
│  2. Parse + clean text           │    │    1. Embed question (Voyage)        │
│  3. Structure-aware chunking     │    │    2. Hybrid search (Supabase RPC)   │
│  4. Embed chunks (Voyage)        │    │       → top 8 chunks + scores        │
│  5. Upsert to Supabase ────────────┐  │    3. Claude answers with native     │
└──────────────────────────────────┘ │  │       citations, streaming          │
                                     ▼  │    4. Stream answer + citations +    │
                              ┌─────────────┐  glass-box data to browser       │
                              │  Supabase   │◄─┘                               │
                              │  (pgvector) │                                  │
                              └─────────────┘                                  │
```

The deployed app only **reads** the database. Ingestion runs locally; a bad ingestion run cannot break production.

## 5. Ingestion pipeline (`scripts/ingest/`)

1. **Download** the official PDF from IFAB (URL pinned in config; the file is also committed to the repo under `data/` for reproducibility, with attribution).
2. **Parse** PDF → text, with cleanup passes for headers, footers, page numbers, and layout artifacts.
3. **Chunk — structure-aware:** the rulebook is organized as Law 1–17, each with numbered sections. Each chunk = one section of one law, carrying metadata: law number, section number, breadcrumb string (e.g. `Law 12 › 2. Indirect free kick`). Oversized sections split at paragraph boundaries with the breadcrumb preserved. Rationale: every retrieved chunk is a semantically complete rule; every citation is precise. (Contrast: fixed-size chunking slices mid-rule.)
4. **Embed** each chunk via Voyage (batched requests).
5. **Upsert** into Supabase `chunks` table. Idempotent per `corpus_version` (e.g. `2025-26`): re-running replaces that version's rows.

### Data model (single table + one RPC)

```
chunks(
  id            bigint PK,
  corpus_version text,        -- e.g. '2025-26'
  law_number    int,          -- 1..17 (or 0 for front-matter/glossary)
  breadcrumb    text,         -- 'Law 12 › 2. Indirect free kick'
  content       text,
  embedding     vector(1024), -- voyage-4-lite dimension; confirm at implementation
  fts           tsvector      -- generated column for keyword search
)
-- indexes: HNSW on embedding, GIN on fts
-- RPC: match_chunks(query_embedding, query_text, k) → hybrid results with scores
```

## 6. Question flow (`POST /api/ask`)

1. **Validate**: password session present; rate limits pass (§8); question length ≤ 300 chars.
2. **Embed the question** with the same Voyage model used at ingestion (vectors from different models are not comparable).
3. **Hybrid search** via one Supabase RPC: vector similarity + Postgres full-text search, merged with Reciprocal Rank Fusion (RRF). Returns top **k=8** chunks with both raw scores and fused rank. Rationale for hybrid: pure vector search is weak on exact tokens ("Law 11", "penalty mark"); keyword search covers that hole.
4. **Relevance gate**: if the best similarity score is below a threshold (tuned during eval), return the fixed "I can only answer questions about the Laws of the Game" response *without* calling Claude.
5. **Generate**: call Claude (`claude-haiku-4-5`) with:
   - System prompt: answer only from the provided documents; decline anything else; concise, plain-English, referee-neutral tone.
   - The 8 chunks passed as **document content blocks with the API's native citations feature enabled** (`citations: {enabled: true}`). The response comes back as text spans, each tagged with which document (chunk) and which sentences support it — structured citations, not prompt-glued "[1]" markers.
   - The user's question as the user message (never concatenated into the system prompt).
   - Streaming enabled.
6. **Respond** (streamed): answer text with citation spans, plus the glass-box payload: all 8 retrieved chunks with breadcrumbs and scores, flagged with which were actually cited.

## 7. UI

Two screens, minimal surface (visual design to be done at implementation time via the `design-process` skill — this spec fixes function, not appearance):

- **Gate screen**: single password field (shared demo password) → sets a session cookie.
- **Ask screen**: question input + submit; streamed answer with inline citation markers; quoted law passages beneath the answer; an expandable **"How this answer was built"** glass-box panel showing the 8 retrieved chunks, their similarity/rank scores, and cited-or-not flags; remaining daily question count for the visitor.

## 8. Guardrails

| Guardrail | v1 setting | Mechanism |
|---|---|---|
| Access | Shared password | Middleware checks session cookie; gate screen sets it |
| Per-visitor rate limit | 20 questions/day | Keyed on IP + cookie, enforced in the API route |
| Global spend ceiling | 500 questions/day total | Counter in Postgres; exceeded → friendly "demo budget reached" response, no API calls |
| Input cap | 300 chars/question | API-side validation |

Worst-case daily cost at ceiling: 500 × ~0.4¢ ≈ **$2/day**, plus Voyage free tier. Going public later = removing the password check only; all other guardrails are public-ready by design.

## 9. Threat model & error handling

**Prompt injection:**
- *Corpus injection (the serious RAG vector): structurally absent.* The corpus is one fixed official PDF ingested by the maintainer. No user uploads, no web crawling — no path for attacker-controlled text to enter retrieved context.
- *Question injection: low blast radius.* The Claude call has no tools and no secrets in context; output is text shown only to the visitor who typed it; no cross-user data exists. Worst case is off-brand text, not a security incident.
- *Hardening anyway:* question stays in the user message; system prompt scopes answers to provided documents; the relevance gate short-circuits most injection strings before Claude sees them; input cap bounds elaboration.

**Cost abuse:** covered by §8 (per-visitor limit + global ceiling + input cap).

**Failure handling:**
- Voyage or Claude API error → honest "something went wrong, try again shortly" + server-side log with request context. No silent failures.
- Claude `stop_reason: "refusal"` (rare safety decline) → checked explicitly, clean fallback message.
- Below-threshold retrieval → fixed off-topic response (also the wrong-domain answer, e.g. cricket questions).

**Secrets:** API keys (Voyage, Anthropic, Supabase service role) server-side env vars only; never in prompts, client code, or the repo. `gitleaks` in CI per the Node.js quality baseline.

## 10. Testing & evals

- **Unit tests (Vitest, CI on every PR):** chunking rules (structure parsing, oversize splitting), RRF merge, relevance gate, rate limiter, input validation, citation-payload mapping. All deterministic logic is unit-tested before PR per the global workflow.
- **Retrieval eval set:** `evals/golden-questions.json` — ~30 hand-written questions, each labeled with the law section(s) a correct answer must draw from. `npm run eval` runs the retrieval pipeline (no generation — cheap) and reports **recall@8** and MRR per question and overall. This is the measurement harness for tuning chunking, k, thresholds, and hybrid weights. Target: establish a baseline first; improve from there (no arbitrary target before a baseline exists).
- **Manual QA:** a smoke list of end-to-end questions (including off-topic and injection-style inputs) before each release.

## 11. Future work (v2 candidates — not designed)

- **FM AI Scout:** plain-English player scouting over the ~150K-player Football Manager dataset ("find a young, cheap left-back like Davies"), reusing the embedding pipeline and app shell. Different archetype (semantic search + recommendation, no document citations). License note: FM data on Kaggle is a gray area — needs a disclaimer. Would be brainstormed as its own spec → plan → build cycle; also a candidate Python project if that skill becomes a goal.
- New-season rulebook edition ingestion + "what changed this year" diff view (schema already versioned).
- Public launch (remove password; guardrails already in place).

## 12. Bootstrap notes (for the `new-project` run following this spec)

- Full New Project Checklist (git already initialized; CLAUDE.md, settings, hooks, Vitest, GitHub setup, CI per `cicd-standards`, Node.js quality baseline incl. commitlint/gitleaks/CodeQL).
- Create the two agents from the 2026-07-08 agent-gap review: global **`security-reviewer`** (dispatched for Mandatory-tier work alongside `/security-review` — here: the password gate, rate limiting, spend-ceiling code) and project-scoped **`test-writer`** (writes tests from spec in a separate context; scope to Vitest + this repo's layout).
- Risk tiers for this project: guardrail/auth code = **Mandatory**; ingestion + retrieval + UI = **Standard**; copy/config = Routine.
