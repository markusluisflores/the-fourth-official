# Laws of the Game RAG — Project Reviewer & Interview Guide

> **Living document.** Updated as new concepts are added or lessons are learned.
> Last updated: 2026-07-08 (design phase — no code yet; everything below traces to `docs/superpowers/specs/2026-07-08-laws-rag-design.md`)

---

## What We Built (design approved 2026-07-08; implementation pending)

A web app that settles football rules arguments by quoting the actual rulebook: ask a rules question in plain English, get an answer grounded in the IFAB Laws of the Game with the exact law sections cited, plus a "glass-box" panel showing how the answer was retrieved (which passages matched, with what scores). First vector-embeddings project in the portfolio; deliberately scoped as a complete, finishable RAG system rather than a broad half-finished one.

**Tech stack (chosen, not yet built):**
| Layer | Choice |
|---|---|
| Framework | Next.js (App Router, TypeScript) |
| DB + vector store | Supabase Postgres + pgvector |
| Embeddings | Voyage AI `voyage-4-lite` |
| Answer generation | Claude Haiku 4.5 (env-swappable) |
| Citations | Claude API native citations feature |
| Testing | Vitest (unit) + custom retrieval-eval harness |
| Hosting | Railway |

---

## Technical Concepts

### 1. RAG — Retrieval-Augmented Generation

**Simple version:** Instead of asking an AI to answer from memory (where it can make things up), you first *look up* the relevant pages in a trusted book, hand those pages to the AI, and say "answer using only this." The citations are the receipts.

**The longer version:** Every question triggers two steps: retrieval (find the rulebook chunks whose embedding is closest in meaning to the question's embedding, plus keyword matches) and generation (Claude answers strictly from those chunks, with each answer span tagged to its source chunk). The LLM never answers from parametric memory alone.

**Interview talking point:** "I built a RAG system over football's official rulebook. The core property I cared about was verifiability — every claim in the answer maps to a specific law section the user can read. That drove most downstream decisions: structure-aware chunking so citations are precise, and the API's native citations feature so attribution is structural rather than prompt-glued."

---

### 2. Corpus selection as a product decision

**Simple version:** Before building a "chat with documents" app, the most important choice is *which documents*. We rejected an obvious option because someone already built it, and rejected an exciting dataset because it was the wrong shape.

**The longer version:** Three candidates were seriously evaluated. Claude Code docs: on-brand but the official docs site already has an AI assistant, so the differentiation burden lands on the app. Football Manager player data: personally exciting, but it's a spreadsheet (rows of stats), not documents — RAG-with-citations needs quotable text, so it's the wrong archetype (it became the v2 semantic-search idea instead). IFAB Laws of the Game won: bounded (~230-page official PDF), authoritative (one rulebook governs the entire sport), question-rich (people argue about football constantly), no famous existing bot, and free to download.

**Interview talking point:** "I evaluated corpora against four criteria: is it quotable text, is it legally usable in public, is it bounded enough to measure retrieval quality against, and do people actually ask questions about it. That last one is underrated — a technically clean corpus nobody queries makes a dead demo. The rulebook hit all four, and rejecting the Football Manager dataset taught me the document/structured-data boundary: stats tables power analytics or similarity search, not citation-based Q&A."

---

### 3. Structure-aware chunking

**Simple version:** The naive way to slice a book for a search system is every N characters, which cuts rules in half mid-sentence. We slice along the book's own structure instead — one chunk per numbered section of each law — so every retrieved piece is a complete rule.

**The longer version:** The Laws of the Game are organized as Law 1–17 with numbered sections. Each chunk = one section, carrying metadata (law number, breadcrumb like `Law 12 › 2. Indirect free kick`). Oversized sections split at paragraph boundaries with the breadcrumb preserved. Consequences: retrieved chunks are semantically complete, citations are precise to the section level, and the eval set can label questions with expected sections.

**Interview talking point:** "Chunking strategy is where RAG quality is won or lost, and it's corpus-dependent. My corpus had strong internal structure, so I chunked along it — one chunk per law section — instead of fixed-size windows. That makes every citation point at a complete rule rather than a fragment, and it makes retrieval evaluation labelable: I can say exactly which section a correct answer must come from."

---

### 4. Hybrid search (vector + keyword, merged with RRF)

**Simple version:** Meaning-based search finds "reboot the app" when you ask about "restarting the application" — but it's surprisingly bad at exact terms like "Law 11". Old-fashioned keyword search is the opposite. We run both and merge the rankings.

**The longer version:** One Supabase SQL function runs pgvector similarity search and Postgres full-text search, then merges the two ranked lists with Reciprocal Rank Fusion (a standard formula that rewards documents ranked high by either method). Top 8 fused results go to generation. Keeping it in one RPC means one round-trip and the whole retrieval story lives in SQL.

**Interview talking point:** "Pure vector search fails on exact identifiers — ask about 'Law 11' and semantically similar text about offside in general can outrank the literal Law 11 chunks. So I ran hybrid retrieval: vector plus full-text, fused with RRF, in a single Postgres function. Postgres with pgvector made that trivial compared to running a separate vector database next to a keyword index."

---

### 5. Two AI providers, one per job (and the same-model rule)

**Simple version:** Claude writes the answers, but Claude's maker doesn't make the text-to-numbers models, so a specialist (Voyage AI) does that part. And a subtle rule: the numbers only mean anything if the *same* model made all of them.

**The longer version:** Anthropic has no embedding models; Voyage is its recommended partner (200M free tokens vs a ~150K-token corpus, so embedding costs ~nothing). Critical invariant: query embeddings and chunk embeddings must come from the same model — vectors from different models live in different spaces and their distances are meaningless. This is pinned in config and would be the first suspect if retrieval quality ever mysteriously collapsed after a dependency change.

**Interview talking point:** "The system uses two providers deliberately: Voyage for embeddings, Claude for generation — each is best-in-class at its half. The gotcha I designed around is embedding-model consistency: you can never compare vectors across models, so the embedding model version is pinned and a re-embed of the whole corpus is the documented cost of upgrading it."

---

### 6. Native API citations instead of prompt-engineered markers

**Simple version:** Instead of begging the AI in the prompt to "please add [1] footnotes" and hoping it complies, the Claude API has a built-in citations mode that returns the answer already tagged with which source document supports each span.

**The longer version:** Retrieved chunks are passed as document content blocks with `citations: {enabled: true}`. The response arrives as spans, each carrying structured references (document index, cited text). No regex parsing of model output, no hallucinated citation numbers, and the glass-box panel can flag exactly which retrieved chunks were actually used.

**Interview talking point:** "I used the API's structural citations rather than prompt-engineered markers. Prompted citations fail silently — models drop or invent markers under load. Structural citations are part of the response schema, so the UI can trust them, and I get 'which chunks were actually cited' for free, which powers the transparency panel."

---

### 7. Scope discipline: phasing with a hard gate

**Simple version:** We had two exciting ideas (rulebook Q&A and a Football Manager scout). Building both at once is how portfolios end up with two half-finished features, so one ships first and the other is a one-paragraph note.

**The longer version:** The FM scout shares most infrastructure (embedding pipeline, vector store, app shell) but doubles the data-modeling and UX work. Decision: v1 is the rulebook RAG only; the scout exists in the spec solely as a future-work paragraph, to be brainstormed as its own spec → plan → build cycle after v1 ships. The architecture keeps the corpus pluggable as a cheap enabler.

**Interview talking point:** "I cut scope deliberately: a finished v1 with published retrieval metrics is worth more than two 60%-done features. But I phased rather than deleted — the second idea is written down with its licensing caveat, and the architecture keeps the corpus layer pluggable so v2 reuses the pipeline. Knowing the difference between 'not now' and 'no' is most of scope management."

---

### 8. Right-sizing the generation model

**Simple version:** The most powerful AI model isn't automatically the right one. Because the answer is grounded in retrieved rulebook text, a small fast model does the job at a fifth of the cost — and it's one config line to upgrade.

**The longer version:** Compared per-question costs at demo traffic (~3K tokens in / 300 out): Haiku 4.5 ≈ 0.4¢, Sonnet 5 ≈ 1¢, Opus 4.8 ≈ 2¢. Grounded generation shifts the intelligence burden to retrieval quality, so Haiku was chosen; the model ID is an env var, and the eval harness gives an objective way to test whether an upgrade actually improves answers.

**Interview talking point:** "Model selection was a measured decision, not a default. RAG moves the hard part into retrieval — the generator mostly restates retrieved text faithfully — so I started with Haiku at a fifth of Sonnet's cost and made the model swappable behind an env var. If eval results ever showed reasoning failures on edge-case questions, upgrading is a one-line change with a harness to prove it helped."

---

### 9. Threat model: why a fixed corpus defuses prompt injection

**Simple version:** The scary version of prompt injection in document-chat apps is attackers hiding instructions *inside the documents*. Our documents are one official PDF that only we load — there's no way in.

**The longer version:** The serious RAG injection vector (attacker-controlled retrieved content) is structurally absent: no user uploads, no crawling. What remains is injection via the question itself, and the blast radius is small by construction: no tools, no secrets in context, no cross-user data — worst case is off-brand text. Hardening anyway: question kept in the user message, system prompt scoped to provided documents, a retrieval-relevance gate that short-circuits most injection strings before Claude sees them, input length cap. Cost abuse is a separate lane: per-visitor limits plus a global daily ceiling (~$2/day worst case).

**Interview talking point:** "I threat-modeled it by asking what an injected prompt could actually *reach*: no tools, no secrets in context, no other users' data — so question-injection is low-stakes by construction, not by filtering. The structural insight is that RAG danger scales with who controls the corpus. Mine is a fixed official PDF, so the document-injection vector doesn't exist; a system retrieving from user uploads or emails inherits an attack surface I deliberately don't have."

---

### 10. Retrieval evals: measuring instead of guessing

**Simple version:** How do you know a change made search better? Not by vibes — by a fixed exam: 30 questions with known correct law sections, scored automatically.

**The longer version:** `evals/golden-questions.json` labels each question with the section(s) a correct answer must cite. The eval script runs retrieval only (no generation — cheap and fast) and reports recall@8 and MRR. Every chunking/threshold/weight change gets measured against the same baseline. Deliberately no arbitrary target before a baseline exists.

**Interview talking point:** "Before tuning anything I built a golden-question set — 30 questions labeled with the law sections a correct answer must draw from — and a script reporting recall@8 and MRR on retrieval alone. That turns 'I think the new chunking is better' into a number. It's the RAG equivalent of writing the test before the code, and it's cheap because it never calls the generation model."

---

## Engineering Process

- **Brainstorm-before-build:** the entire design (corpus, archetype, stack, guardrails, threat model) was settled and spec'd (`docs/superpowers/specs/2026-07-08-laws-rag-design.md`) before any code. Several ideas died cheaply in conversation instead of expensively in code — the FM-dataset-as-corpus idea was redirected in minutes.
- **Right-sized honesty:** the spec records that at ~1K chunks an in-memory search would technically suffice; pgvector was chosen to demonstrate the production pattern. Knowing (and saying) when a technology is overkill is part of the story.
- **Risk tiering planned up front:** guardrail/auth code = Mandatory tier (full review stack incl. a dedicated security-reviewer agent), ingestion/retrieval/UI = Standard, copy/config = Routine.
- **Offline/online separation:** production only reads the DB; ingestion runs locally and is idempotent per corpus version — a bad ingestion run can't break the live site.

## Bugs & Lessons

*(None yet — implementation hasn't started. This section fills in as retros and fixes accumulate.)*

## Talking Points (quick index)

1. Verifiability drove the architecture (citations → chunking → evals).
2. Corpus choice is a product decision with four concrete criteria.
3. Documents vs structured data — why FM stats couldn't be "the corpus."
4. Structure-aware chunking > fixed-size windows (when the corpus has structure).
5. Hybrid search: vector search's exact-identifier blind spot and RRF.
6. Embedding-model consistency: vectors from different models don't mix.
7. Native structural citations > prompt-engineered markers.
8. Scope: phased with a hard gate; pluggable corpus as the cheap enabler.
9. Model right-sizing with an escape hatch and a harness to justify upgrades.
10. Threat model: corpus control determines RAG injection risk; blast-radius reasoning.
11. Evals-first tuning: recall@8/MRR baseline before any optimization.
