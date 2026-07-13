# Laws of the Game RAG — Project Reviewer & Interview Guide

> **Living document.** Updated as new concepts are added or lessons are learned.
> Last updated: 2026-07-12 (Part 1 — ingestion + retrieval — completed 2026-07-09. Part 2a — ask API, guardrails, gate calibration — completed 2026-07-12. Traces to `docs/superpowers/specs/2026-07-08-laws-rag-design.md`.)

---

## What We Built (design approved 2026-07-08; Part 1 implemented 2026-07-09)

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

## Part 2a — Ask API, Guardrails & Gate Calibration (implemented 2026-07-12)

Lifted Part 1's pure retrieval system into a public `/api/ask` route with password authentication, rate limiting (per-visitor + global ceiling), and a calibrated relevance gate to filter low-confidence matches before generation. Route returns Server-Sent Events for streaming answers with citations and glass-box retrieval-trace output.

**Gate calibration** (Task 3 evals, live against 118-chunk corpus):
- **On-topic floor** (golden questions): `maxSimilarity` of best match across 30 correctly-answered questions ranged 0.351–0.966, floor 0.351.
- **Off-topic ceiling** (cricket/NBA/basketball probes, and non-sport controls): `maxSimilarity` for sport-adjacent questions ranged 0.309–0.493, ceiling 0.493.
- **Chosen threshold:** `RELEVANCE_THRESHOLD = 0.35` (on-topic floor, not a midpoint). Rationale: the ranges don't cleanly separate; a soft gate alone can't reliably filter category drift. Accepted trade-off — a few adjacent-sport questions (e.g., cricket Q scoring 0.352, just above threshold) pass the gate and rely on the system prompt as a second line of defense (Claude correctly declined the cricket question via the `system_prompt` instruction to answer only football questions).
- **Verification:** live testing on a real cricket question confirmed the gate behavior — low-confidence boundary cases do reach Claude, which correctly applies the domain boundary in the system prompt.

**Paraphrase-tier recall** (colloquial re-phrasings of golden-question topics, measured against live corpus):
- 10/10 questions correctly answered (100% recall@8)
- MRR: 0.863 (vs. golden set's 30/30, MRR 0.859)
- **Honest caveat:** this set, like the golden set, was authored for this project and doesn't represent truly unseen phrasing. This measures robustness to colloquial synonyms within domain expertise, not zero-shot domain transfer. Real-world validation would require field testing.

**Citations & transparency:**
This app uses Claude API's native `citations: {enabled: true}` document-block feature rather than prompt-engineered citation markers like `[1]`, `[2]`. Each citation arrives as a structured field (`cited_text`, `start_char_index`, `end_char_index`) tied to the retrieved chunk's index, not free text the model is asked to format. Consequence: the UI can trust citation locations exactly (no hallucinated markers), and the glass-box panel knows which retrieved chunks were actually used (by matching the citation document index to the retrieval trace). **Interview talking point:** "I used structural citations from the Claude API rather than asking the model to insert markers — a model-emitted marker can drop or be malformatted under load, but a structured response field can't be hallucinated."

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

**Baseline (measured 2026-07-09, `npm run eval` against the live 118-chunk corpus, `corpus_version 2025-26`):**

| Metric | Value |
|---|---|
| Recall@8 | **30/30 = 100.0%** |
| MRR | **0.859** |

All 30 golden questions were reviewed and approved by the project owner for football correctness before this run (including a correction to one of the original draft questions — the goalkeeper ball-holding rule now resolves to `Law 12 › 3` "Corner kick," reflecting the current 8-second/corner-kick rule, not the older indirect-free-kick sanction). Zero MISSes, so no retrieval-gap backlog exists yet from this eval set — the honest caveat is that a 100% score partly reflects that the golden questions were themselves written from the same chunk text retrieval searches over, so this baseline is a floor to defend, not proof the system handles messier real-world phrasing. `RELEVANCE_THRESHOLD = 0.35` was sanity-checked with an off-topic probe (a cricket-rules question) that returned `maxSimilarity ≈ 0.309`, correctly gated out by `isRelevant()`. **Superseded:** this was an informal Part 1 spot-check, before the Part 2a threshold calibration existed and before Task 1's `match_chunks` fix changed how similarity is computed for every row. The authoritative number is the Part 2a calibration below (0.352, passes the gate).

**Interview talking point:** "Before tuning anything I built a golden-question set — 30 questions labeled with the law sections a correct answer must draw from — and a script reporting recall@8 and MRR on retrieval alone. That turns 'I think the new chunking is better' into a number. Baseline came back 100% recall@8 with an MRR of 0.859, which is a good sign for hybrid retrieval on a well-structured corpus, but I'm honest in interviews that a self-authored golden set has selection bias — the real test is how it holds up on phrasing I didn't write, which is the next iteration."

---

## Engineering Process

- **Brainstorm-before-build:** the entire design (corpus, archetype, stack, guardrails, threat model) was settled and spec'd (`docs/superpowers/specs/2026-07-08-laws-rag-design.md`) before any code. Several ideas died cheaply in conversation instead of expensively in code — the FM-dataset-as-corpus idea was redirected in minutes.
- **Right-sized honesty:** the spec records that at ~1K chunks an in-memory search would technically suffice; pgvector was chosen to demonstrate the production pattern. Knowing (and saying) when a technology is overkill is part of the story.
- **Risk tiering planned up front:** guardrail/auth code = Mandatory tier (full review stack incl. a dedicated security-reviewer agent), ingestion/retrieval/UI = Standard, copy/config = Routine.
- **Offline/online separation:** production only reads the DB; ingestion runs locally and is idempotent per corpus version — a bad ingestion run can't break the live site.

## Bugs & Lessons

- **`npm run eval` needed the same Node 20 WebSocket flag as `npm run ingest`.** `@supabase/supabase-js` initializes a realtime client (even though nothing here uses realtime) that requires native WebSocket support; Node 20 needs `NODE_OPTIONS=--experimental-websocket`. The `ingest` script already had this wrapper; `eval` was missing it and failed outright on first run. Fixed by adding the same `cross-env NODE_OPTIONS=--experimental-websocket` wrapper.
- **Voyage's free tier is 3 requests/minute without a payment method on file**, which the 30-question eval blows through in about 3 questions. `evals/run-evals.ts` got a small retry-with-backoff wrapper around `searchChunks` so a full eval run survives the free-tier ceiling end to end rather than dying on the fourth question's 429.

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

---

## Part 2a Review & Part 2b Design (2026-07-12)

> Appended at the end of the file on purpose: PR #16 (in flight) edits this file's
> earlier sections, and overlapping edits on `main` would conflict at merge. Fold
> these into their proper places during the next interview-prep capture pass.

### The security call I didn't make: no login rate-limiter

**The story:** `POST /api/session` has no lockout on password attempts — and the review's ruling was to *keep it that way*. Any per-IP attempt limiter would key on `x-forwarded-for`, which the client controls until the deploy platform's proxy chain is verified; a rate limiter built on an attacker-controlled key is security theater. The endpoint costs one HMAC per attempt (no paid API behind it), a brute-forced session grants nothing beyond what any visitor has, and spend is capped by the global daily ceiling regardless. The real mitigation is operational: a 32+-character random password, making guessing mathematically irrelevant.

**Interview talking point:** "My favorite security decision in this project is one where I *refused* to add a control. A login rate-limiter would have keyed on a spoofable header — a lock made of the thing we don't trust. Security review isn't 'add more controls'; it's knowing which controls are load-bearing and which are theater. I documented the accepted risk, bounded it with the spend ceiling, and made the password's entropy the actual defense."

### Bundled deploy blockers: why two fixes ship as one task

**The story:** two real gaps — the per-visitor limit trusts a client-controllable header hop, and the global budget counter incremented even for rejected requests (one griefer could drain everyone's 500/day at zero cost). The counter fix is platform-independent and tempting to ship alone, but alone it's defeated by header rotation. Both were made one Mandatory-tier deploy-blocking task: verify Railway's trusted hop live (empirical probe, not guessed), then fix both.

**Interview talking point:** "Two plausible-looking patches can individually be worthless: fixing the counter ordering without fixing IP trust just moves the griefing one header-rotation away. I bundled them into one deploy-blocking task, with the platform's actual proxy behavior verified by a live probe before the parsing code is written — the 'correct' forwarded-for hop is an empirical fact about the platform, not something you look up and hope."

### UI identity: a reference desk, not a chat

**The story:** the obvious genre for "type a question, watch the answer stream" is a chat transcript. Rejected on honesty grounds: the API is stateless — no memory, no follow-ups — and a chat costume advertises capability that doesn't exist. The ask screen frames each answer as a *ruling* with the cited law passages directly beneath, and same-visit history is a collapsed client-side list (re-reading a ruling is free; re-asking costs one of the visitor's 20 daily questions). Citation markers click-to-scroll rather than hover-preview — Perplexity's hover previews solve an off-screen-sources problem this layout doesn't have.

**Interview talking point:** "The UI's job is to tell the truth about the system. A chat transcript would promise follow-up memory the API doesn't have, so I built a reference-desk instead: question in, ruling out, sources one glance below. Same reasoning killed hover previews for citations — that pattern exists because other products' sources are off-screen links; mine are already on the page. Copying genre conventions without asking what problem they solve is how UIs lie."

### The yellow card that didn't look yellow

**The story:** the palette maps referee semantics onto UI states — pitch-green accent, yellow-card warnings, red-card errors. First pass rendered "yellow card" as amber-brown text (`#B45309`), because true card yellow as *text* on white is unreadable (~1.5:1). The reviewer (Markus) rejected it on sight. The fix wasn't a different tint but a different role: a yellow card is a yellow *object*, so the color moved into a card-shaped badge fill (true `#FACC15`, dark text on it, ~12:1) with message text in the normal foreground.

**Interview talking point:** "Accessibility constraints don't force ugly compromises if you ask which *role* a color plays. I couldn't make true yellow readable as text, so the yellow became a filled card-shaped badge — more literal to the domain *and* higher contrast than the amber compromise it replaced. When a color fails contrast, the answer is often 'stop using it as text,' not 'pick a muddier color.'"

### Process engineering: the pipeline that swallowed a decision

**The story (Claude Code workflow material):** the design-research tooling outputs exactly one recommended design system — and that single recommendation sailed into mockups as if it were a decision, until the user asked why he'd never been offered a color choice. Structured workflow had fixed one failure mode (skipping research) and quietly created another (research output consumed as decisions). Same session, two more gaps caught the same way: color swatches presented as `■ #hex` text lines are invisible as colors in a terminal (palettes now ship as rendered PDFs via headless Edge), and a subagent once committed to `main` because its dispatch prompt named the working directory only as prose (dispatch templates now require `pwd && git branch --show-current` as the literal first command). All three were patched at the source — skill files and global config — the same day.

**Interview talking point:** "The recurring failure class in agentic workflows is rules that only conflict in situations nobody has hit yet — you can't find them by reading the rules, only by walking real scenarios through them. My working rule: when a human catches one, the fix goes into the skill or template that generated the behavior, that day — never into 'remembering to do better.' A workflow that improves by memory doesn't improve."

### Part 2b design decisions (quick reference)

Reference-desk ask screen · collapsed same-visit history (client-only) · click-to-scroll citations with highlight flash · glass box open on first answer, then user-controlled · referee's-kit palette v2 (card-shaped badge fills). Full record with rejected options: `docs/superpowers/specs/mockups/2026-07-12-part2b-ui-mockup.md`; spec: `docs/superpowers/specs/2026-07-12-laws-rag-part2b-ui-deploy-design.md`.
