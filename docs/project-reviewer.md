# Laws of the Game RAG — Project Reviewer & Interview Guide

> **Living document.** Updated as new concepts are added or lessons are learned.
> New to vector/RAG vocabulary? The **Glossary** at the end of this file defines every term this project uses in plain English.
> Last updated: 2026-07-15 (Part 1 — ingestion + retrieval — completed 2026-07-09. Part 2a — ask API, guardrails, gate calibration — completed 2026-07-12. Part 2b — UI, guardrail hardening, Railway deploy — completed 2026-07-13; PR #27 approved by a fresh-context review and merged 2026-07-14. Post-merge: PRs #32–#36 (issues #30/#31 fix, compound-eval tier, workflow-audit fixes, docs) all reviewed and merged 2026-07-15. Query decomposition — the compound-question fix — spec'd and planned 2026-07-15 (PR #46, Concept 19); execution pending. Traces to `docs/superpowers/specs/2026-07-08-laws-rag-design.md`.)

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

## Part 2b — UI, Guardrail Hardening & Railway Deploy (implemented 2026-07-13)

Shipped the app's first user-facing surface — a password gate and an ask screen — on top of Part 2a's frozen SSE API contract, plus a Mandatory-tier guardrail-hardening pass and a live Railway production deploy.

**UI identity — reference desk, not chat:** each answer is framed as a *ruling* with cited law passages directly beneath it, not a chat transcript. Same-visit history is a collapsed client-side list; citation markers click-to-scroll-and-flash rather than hover-preview. See Concept 13 below for the reasoning.

**Guardrail hardening:** HMAC domain separation (session vs. password signing no longer share replayable signature space), migration `0005` (closes a global-budget griefing path — see Concept 11 — and hardens RPC grants), Next.js 16 `proxy.ts` adoption with page-level auth gating, SSE stream abort on client disconnect (stop paying for tokens once nobody's listening).

**The trusted-IP fix, empirically verified live:** the deploy-blocking task from Part 2a's review (client-controllable `x-forwarded-for`) was closed by probing the actual deployed Railway app rather than trusting platform documentation or convention. See Concept 11 — the result reversed the original assumption.

**Deployed:** https://the-fourth-official-production.up.railway.app. Eval regression after all changes: golden 30/30 (MRR 0.859), paraphrase 10/10 (MRR 0.863) — unchanged from Part 1/2a baseline, confirming the guardrail/UI work didn't touch retrieval behavior.

**Merged 2026-07-14** after a fresh-context review (approve, no blockers — full review on PR #27). The review's two follow-up-sized findings were filed as prioritized issues (#30, #31) rather than left in the merged PR's comment thread; its rulings on the four open handoff questions (compound-question recall, verification sequencing, the XFF probe's validity, microcopy clarity) are recorded in the same review comment.

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

### 11. Empirical platform verification: the XFF probe that reversed a security assumption

**Simple version:** A prior review flagged that the app trusted a header a visitor could fake to dodge their daily question limit. The fix everyone assumes ("trust the last value in the chain") turned out to be backwards on this specific hosting platform — and the only way to find that out was to actually test it live, not read documentation or guess.

**The longer version:** Part 2a's review found two related gaps that had to ship together: the per-visitor rate limit keyed on `x-forwarded-for`, a header a client can set to any value until you know which hop your hosting platform's proxy actually controls; and the global daily-spend counter incremented even for requests later rejected for exceeding the visitor's own cap (one griefer could burn the shared budget for everyone at zero cost, since fixing only the counter ordering without fixing IP trust is defeated by simply rotating the header). Both were bundled into one Mandatory-tier, deploy-blocking task rather than shipped separately, because either fix alone is worthless without the other.
Closing it required a live probe against the deployed Railway app: send several requests with different (and absent) spoofed `x-forwarded-for` values from the same real machine, log what the server actually receives, and independently verify the machine's real public IP via two external IP-echo services. The result was the opposite of the assumed model — Railway's edge doesn't append the real client IP to whatever the client sends (making the last entry trustworthy, the common pattern); it **overwrites the header entirely** with the real IP as the *first* entry and appends its own internal hop after. None of four different spoofed values ever survived to the server. Practical result: there was no spoofing vector to defend against on this platform at all, but the extraction logic needed to read the first entry, not the last — the reverse of what the original review assumed. The fix was verified live end-to-end afterward: two database snapshots bracketing one extra production request showed the exact-same rate-limit counter row incrementing, confirming the same real client always resolves to the same key.

**Interview talking point:** "A prior review flagged a header-trust gap and assumed the standard fix — trust the last hop in the forwarded-for chain. I didn't ship that. I put a temporary log line on the deployed app, sent it a handful of requests with different fake values, and checked what actually arrived against my own independently-verified IP. The platform turned out to overwrite the header entirely rather than appending to it, with the real IP landing first, not last — the exact opposite of the common assumption. The lesson isn't about that specific header; it's that a security control based on a platform behavior you haven't verified live is a guess wearing a control's clothing. I'd rather ship a probe than ship an assumption."

---

### 12. The security call I didn't make: no login rate-limiter

**Simple version:** The obvious "secure" move — locking an account after too many wrong passwords — was rejected on purpose, because the lock would be keyed on something an attacker controls.

**The longer version:** `POST /api/session` has no lockout on password attempts, and the review's ruling was to keep it that way. Any per-IP attempt limiter would key on the same `x-forwarded-for` header from Concept 11 — before that header's trust was verified, a rate limiter built on an attacker-controlled key is security theater, not a control. The endpoint costs one HMAC comparison per attempt (no paid API call sits behind it), a brute-forced session grants nothing beyond what any ordinary visitor already has, and total spend is capped by the global daily ceiling regardless of how many sessions exist. The actual mitigation is operational: a 32+ character random password (generated fresh for production, never reused from local development), making brute-forcing mathematically irrelevant rather than rate-limited.

**Interview talking point:** "My favorite security decision in this project is one where I refused to add a control. A login rate-limiter would have keyed on a header I didn't yet know was trustworthy — a lock built from the thing you don't trust. Security review isn't 'add more controls,' it's knowing which controls are load-bearing and which are theater. I documented the accepted risk, bounded its blast radius with the spend ceiling, and made password entropy the real defense instead."

---

### 13. UI identity: a reference desk, not a chat

**Simple version:** The obvious genre for "type a question, watch an answer stream in" is a chat transcript. That genre was rejected on honesty grounds — the API has no memory between questions, so a chat UI would visually promise a capability that doesn't exist.

**The longer version:** The API is stateless: no conversation memory, no follow-up awareness. A chat transcript UI implies both. Instead, the ask screen frames each answer as a *ruling*, with the cited law passages directly beneath it — question in, verdict out, sources one glance away. Same-visit history is a collapsed, client-side-only list (re-reading an earlier ruling is free; re-asking a question costs one of the visitor's 20 daily questions, so the UI shouldn't make re-reading look like re-asking). Citation markers click-to-scroll-and-flash to their source passage rather than showing a hover preview — hover-preview patterns (e.g. Perplexity) exist to solve an off-screen-sources problem this single-page layout doesn't have.

**Interview talking point:** "The UI's job is to tell the truth about the system underneath it. A chat transcript would promise conversational memory the API doesn't have, so I built a reference-desk layout instead — question in, ruling out, sources one glance below. The same reasoning killed a hover-preview affordance for citations: that pattern exists to solve an off-screen-sources problem, and my sources are already on the page. Copying a UI genre's conventions without asking what problem they actually solve is how an interface ends up lying about what the product does."

---

### 14. Accessible color needs the right role, not a duller shade

**Simple version:** The color palette maps referee semantics onto the interface — a warning looks like a yellow card, an error like a red one. The first version of the yellow warning failed a basic readability check, and the fix wasn't a duller yellow, it was putting the yellow somewhere else.

**The longer version:** True "card yellow" as body text on a white background has a contrast ratio of roughly 1.5:1 — unreadable, and the first implementation shipped exactly that (an amber-brown compromise, `#B45309`, to make it legible). The reviewer rejected it on sight for not looking like a real yellow card. The actual fix changed which *role* the color played rather than its shade: a yellow card in real life is a small colored object, not colored text, so the true yellow (`#FACC15`) moved into a card-shaped badge fill with normal dark text on top of it — about 12:1 contrast, and closer to the domain metaphor besides.

**Interview talking point:** "When a color fails a contrast check, the instinct is to mute it until it passes — I did that first, and it looked wrong to anyone who's actually seen a yellow card. The real fix was asking what *role* the color should play. True yellow can't be readable body text, but it's a perfectly good badge fill with dark text on top — more accurate to the domain and better contrast than the muted compromise it replaced. 'Stop using this color as text' is often the right answer where 'pick a duller version' just produces a worse compromise."

---

### 15. Fresh-context review catches what per-task review structurally can't

**Simple version:** Ten sub-tasks were each built and reviewed individually and passed cleanly. A final, broader review — done by a reviewer who hadn't seen any single task's own reasoning — still found a real bug, because it was a bug in how two tasks' outputs interacted, not in either task alone.

**The longer version:** One task built a state machine (a reducer) against its own specification; a later task built the UI against that reducer's existing, already-tested behavior. Both passed their own reviews. The actual defect only existed at the seam: the underlying generation function always emits a "done" event immediately after a "refusal" event, but the reducer's handling of "done" unconditionally overwrote whatever phase came before it — silently erasing the refusal state a moment after it was set. The reducer's own unit test for the refusal case had only exercised "refusal" in isolation, never followed by the "done" that always follows it in the real system, so a passing test coexisted with broken end-to-end behavior. A final review pass across the *entire* branch, from a fresh context with no attachment to either task's original diff, traced the real runtime event sequence and caught it; fixed with a one-line guard plus a corrected test asserting the actual sequence.

**Interview talking point:** "Two components can each be individually correct and well-tested, and still be wrong together — that's the class of bug per-task or per-PR review structurally can't see, because neither task's own tests exercise the *other* task's real behavior. My mitigation was a mandatory final review pass across the whole branch, done by a reviewer with zero memory of either task's implementation, tracing actual runtime sequences rather than trusting each task's own passing tests. It caught a real defect — a refusal getting silently overwritten by the event that always follows it — that eleven individually-clean reviews had missed."

---

### 16. Process engineering: rules that only conflict in situations nobody has hit yet

**Simple version:** Some workflow rules look complete when you read them, and only turn out to have a gap when a real, specific situation walks through them — you can't find those gaps by re-reading the rules, only by testing them against actual scenarios.

**The longer version (Claude Code / agentic-workflow material):** Several instances of the same failure class surfaced across this project's build. In one design session, research tooling produced exactly one recommended design system, and that single recommendation flowed into mockups as if it were an already-made decision — until the person it was built for asked why he'd never actually been offered a color choice; a structured workflow had fixed one failure mode (skipping research) while quietly creating another (treating research output as a decision). In the same session, color swatches rendered as plain `■ #hex` text lines turned out to be invisible as colors in a terminal, and a sub-agent once committed code to the main branch because its dispatch instructions named the working directory only in prose rather than as a command to run and verify. Later, during this project's Part 2b build, the same class showed up twice more: an automated permission safeguard correctly blocked typing a test password into a browser-automation tool, but there was no way to mark that specific password as a disposable, non-production value safe for that purpose — so a legitimate verification step became stuck; and a UI label reading "15/20 today" was read by its first real user as "5 remaining" rather than "15 remaining," a genuinely ambiguous format that survived design research, an automated design-intelligence pass, implementation, and code review, because none of those steps' job is to read a shipped string with completely fresh eyes and ask if a stranger would misread it.

**Interview talking point:** "The recurring failure class I've learned to watch for in agentic workflows is rules that only conflict in a situation nobody's hit yet — you can't find them by reading the rule, only by walking a real scenario through the whole pipeline and asking where it could have gone wrong. My practice is: the moment a human catches one, the fix goes into the source — the skill file, the review checklist, the dispatch template — the same day, never into 'remember to be more careful next time.' A workflow that only improves by memory doesn't actually improve; one where the fix lands in the artifact that generates the behavior does."

---

### 17. Server-only data access: denying a key that would have been "safe" (ADR-001)

**Simple version:** The rulebook text in the database is public information — letting the web page read it directly would have been defensible. We denied it anyway: the browser has *no* path to the database at all, because the moment one exists, every usage limit and gate can be walked around.

**The longer version:** ADR-001 weighed two options for database access. Option A: ship Supabase's anon key with read-only row-level-security policies on `chunks` — defensible, since the Laws of the Game aren't sensitive. Option B: server-only access — RLS enabled with **zero policies** (deny-all), no anon key generated anywhere, and every read going through the service-role key in modules guarded by `import "server-only"` so accidental inclusion in a client bundle fails at *build* time, not runtime. Option B won because the guardrails (per-visitor/global rate limits, the relevance gate, session auth) only hold if server code mediates every data access — a direct client-to-Supabase path would bypass all of them — and nothing in the app needed a client read, so the structural win cost zero functionality. The browser receives chunk data exclusively through `/api/ask`'s streamed response. The ADR names its own revisit trigger: a future public "browse the rulebook" page that skips the API would require explicit RLS policies in a new migration and a conscious reversal.

**Interview talking point:** "My favorite kind of security decision is one that removes an attack surface instead of defending it. A read-only public key for non-sensitive rulebook text would have been perfectly defensible — I still said no, because my rate limits and relevance gate only exist in server code, and any direct browser-to-database path would route around them. Since no feature needed client reads, deny-all RLS with zero policies and a build-time `server-only` guard bought structural impossibility for free. The ADR also records what would change my mind, so the decision is revisitable instead of folklore."

---

### 18. Deterministic hooks vs. advisory rules — and when the blunt rule is the correct one

**Simple version:** When an AI-agent workflow rule gets broken once and a "please don't do that again" instruction gets written down, that instruction is only as strong as the agent remembering to follow it. Sometimes the fix is turning the instruction into an automatic checkpoint the agent literally cannot skip. Sometimes, though, the *existing* blunt rule turns out to already be the right one, and building a smarter exception for it would make things worse, not better.

**The longer version:** Two workflow-tooling decisions from the same session make the contrast concrete, both from a periodic self-audit of this project's own Claude Code setup. First: a rule requiring every code-writing subagent's dispatch prompt to open with a literal directory/branch verification command had been enforced only by prompt text since a real incident (a subagent committed to the wrong branch because its instructions named the directory only in prose). Rewriting the prompt template again wouldn't close the gap a second time the same way — so it became a `PreToolUse` hook on the `Task` tool: a script that inspects a dispatched subagent's prompt and escalates to a human decision (not a hard block — the heuristic isn't precise enough to safely deny outright) if the literal command is missing. Validated against synthetic test cases and real dispatch prompts from the session before being registered, and registered only after explicit sign-off given its blast radius — it runs on every future agent dispatch, across every project, not just this one. Second, and the actual interesting case: a separate rule blocks the agent from ever typing a password into a browser tool, even a project's own disposable test password, which had blocked a live click-test of a bug fix twice. The instinct was to build an exception — a sandboxed environment where the disposable password could safely be used. Pushback on "would that even work, and is it worth building" led to a different conclusion: the block is a *deliberately* blunt rule, and that's a feature — any mechanism smart enough to distinguish "safe test secret" from "real credential" needs some signal to make that call, and that signal becomes its own attack surface (a malicious page could just assert a real credential is the safe one). Building infrastructure to route around a rule that's already correctly calibrated would have been solving the wrong problem.

**Interview talking point:** "Not every friction point in an agentic workflow should get engineered away — sometimes the friction *is* the safety property. I watched myself nearly build a sandbox to route around a credential-handling rule before realizing the rule's bluntness was deliberate: a smarter version would need a trust signal, and that signal is itself exploitable. In the same session I did convert a different rule — a directory/branch check that had only ever been prompt text — into an actual hook, because that one really was a mechanical, unambiguous check with no judgment call in it. The skill isn't 'hooks are always better than prose,' it's telling apart the failure that needs a mechanical backstop from the one where the mechanical backstop would be the actual vulnerability."

---

### 19. Query decomposition: designing the fix only after measurement justified it

**Simple version:** Some questions are really several questions wearing one sentence — "what happens if everyone gets a red card?" needs the rules for sending players off, for abandoning a match, AND for how results get decided. One search can't sit close to all of those at once. The fix: quietly ask a small AI model to split the question into its parts, search for each part, and combine the results — while a normal search runs in parallel, so ordinary questions never wait, and if the splitter fails in any way the app behaves exactly as it did before.

**The longer version:** The compound-question eval tier (built first, as its own deliverable) turned an anecdote into a decision instrument: full coverage was 3/9 at the production k=8, rising to 7/9 at k=24 — but two questions, including the original live failure, never reached full coverage at any k. That killed the cheap alternative (just raise k) with data and left decomposition as the only real candidate. The design (spec `2026-07-15-query-decomposition-design.md`, PR #46): a Claude Haiku call with a structured-outputs JSON contract splits the question into 1–4 self-contained sub-questions; it races the baseline retrieval in parallel, so the majority-case simple question pays no added latency and a compound verdict reuses the baseline result in the merge. Sub-question results merge by rank round-robin (each sub-question's best evidence survives the cap) with dedupe and a 12-chunk cap; the relevance gate applies to the merged set's max similarity, preserving abstain behavior. Two containment decisions matter most: every decomposer failure mode — malformed output, refusal, API error, timeout — falls back to the exact single-pass path, so the feature can never make the product worse than the day before it shipped; and the decomposer's output is treated strictly as data (it steers embeddings and search queries, never enters any prompt — the answering model still sees only the visitor's original question), because it's the first production code where an LLM's output steers later processing.

**Interview talking point:** "I found the failure live, but I didn't fix it live — I built the measuring instrument first. The eval tier showed that raising the retrieval count would fix most compound questions but provably not the one that started the investigation, so the extra LLM call had to earn its place with data before I designed it. The design itself is containment-first: the splitter races the normal search in parallel so simple questions pay nothing, every failure mode falls back to the previous behavior, and the splitter's output is data that steers retrieval — it never touches a prompt, because an LLM whose output feeds later processing is a new attack surface and I wanted its worst case to be 'a weird search,' which the system already survives daily."

**Execution and measurement:** The measured baseline is what justified decomposition over the cheaper alternative of just raising k — 2 of the 9 compound questions, including the original live failure, never reached full coverage even at k=24, so no amount of retrieval-count tuning alone would have closed the gap. The soft-deadline race (spec §3/§4/§7, added mid-execution after a task review) is the piece that makes the latency story honest: a naive `Promise.all([searchChunks, decompose])` — the reference shape the implementation plan originally specified — would have blocked *every* request, simple or compound, on decompose's full latency; the elapsed-aware race instead bounds how long `/api/ask` waits on decompose before falling back to the baseline path, so simple questions pay a small, capped tax instead of the full call. The fallback contract (decompose failures — malformed output, refusal, API error, timeout — all resolve to the exact single-pass path) means the decomposer can structurally never make retrieval worse than the pre-decomposition system, only better or unchanged. Real measurement (Task 5, n=72 dedicated sample against a live Anthropic call) found the soft deadline misses only 2.8% of the time at `DECOMPOSE_SOFT_DEADLINE_MS=2500ms`, and simple-question added latency stayed at p50 ~781ms (max ~2182ms, n=10) — both comfortably inside their acceptance bars. Compound full coverage rose from 3/9 at baseline to 5/9–7/9 with decomposition (two `--decompose` eval runs differed due to the LLM split's inherent nondeterminism, both recorded rather than picking the more favorable one).

---

## Engineering Process

- **Brainstorm-before-build:** the entire design (corpus, archetype, stack, guardrails, threat model) was settled and spec'd (`docs/superpowers/specs/2026-07-08-laws-rag-design.md`) before any code. Several ideas died cheaply in conversation instead of expensively in code — the FM-dataset-as-corpus idea was redirected in minutes.
- **Right-sized honesty:** the spec records that at ~1K chunks an in-memory search would technically suffice; pgvector was chosen to demonstrate the production pattern. Knowing (and saying) when a technology is overkill is part of the story.
- **Risk tiering planned up front:** guardrail/auth code = Mandatory tier (full review stack incl. a dedicated security-reviewer agent), ingestion/retrieval/UI = Standard, copy/config = Routine.
- **Offline/online separation:** production only reads the DB; ingestion runs locally and is idempotent per corpus version — a bad ingestion run can't break the live site.
- **Subagent-driven development at scale (Part 2b, 11 tasks):** each task got a fresh implementer with no memory of prior tasks' reasoning, a spec-compliance-and-quality review before being marked done, and fix-then-re-review loops where findings surfaced (four of eleven tasks needed at least one fix round). Ended with a Mandatory-tier battery beyond the per-task gates: a dedicated security review across the whole branch, an automated security scan, and a final whole-branch review on the most capable available model — the layer that caught Concept 15's cross-task bug.
- **An incomplete verification step is treated as a blocker, not a footnote:** when a task's own manual-testing step couldn't be fully completed (a live interactive check was blocked by a credential-safety guard), the process learned mid-project to treat that as equivalent to a failed check requiring explicit resolution or human sign-off — not something to note in a report and let the next task quietly inherit.
- **Post-merge findings become issues, not comment-thread memory:** the final PR's fresh-context review approved with two follow-up-sized defects, and the PR merged with them known. Each immediately became a labeled, prioritized GitHub issue (#30 P2, #31 P3) with root cause and fix shape, referencing the review. The principle: a merged PR's review thread is an archival record nobody re-reads for open work — the issue tracker is the work queue, so anything unfixed at merge time must cross over or it silently evaporates.

## Bugs & Lessons

- **`npm run eval` needed the same Node 20 WebSocket flag as `npm run ingest`.** `@supabase/supabase-js` initializes a realtime client (even though nothing here uses realtime) that requires native WebSocket support; Node 20 needs `NODE_OPTIONS=--experimental-websocket`. The `ingest` script already had this wrapper; `eval` was missing it and failed outright on first run. Fixed by adding the same `cross-env NODE_OPTIONS=--experimental-websocket` wrapper.
- **Voyage's free tier is 3 requests/minute without a payment method on file**, which the 30-question eval blows through in about 3 questions. `evals/run-evals.ts` got a small retry-with-backoff wrapper around `searchChunks` so a full eval run survives the free-tier ceiling end to end rather than dying on the fourth question's 429.
- **A refusal could render as a blank screen instead of a decline message** — see Concept 15. Symptom: on a model refusal, the ruling area would show nothing instead of "The Fourth Official declined to answer that one." Root cause: the state machine's handling of the stream-completion event unconditionally overwrote whatever phase preceded it, including a just-set refusal phase, because the unit test for the refusal path had never included the completion event that always follows it in production. Fix: a one-line guard plus a corrected test asserting the real event order. Prevention takeaway: a reducer test that stops the action sequence one event early can pass while the real system is broken.
- **A known retrieval limitation was documented instead of reactively patched.** Manual testing surfaced that a compound question touching four law sections at once ("what happens if everyone gets a red card?") outruns single-pass k=8 retrieval: the 8 retrieved chunks covered three of the four relevant laws, the answer cited what it retrieved with complete accuracy, but the passages needed to *fully* resolve the question didn't all make the cut. Verified directly against the live API (the missing chunks were absent from the top 8 for that query's embedding). Disposition, after review: not a bug to hot-patch — k=8 was calibrated by the eval harness, raising it dilutes every question's context to serve rare compound ones, and query decomposition is a real feature deserving its own design cycle. The limitation is documented, and compound multi-section questions are earmarked as a known-fail eval category to be added before any future retrieval change. Lesson: "the system answered accurately but incompletely, and we can prove exactly why" is a stronger position than a reflexive parameter bump nobody measured. Baseline measured 2026-07-14: full coverage 3/9 at k=8, 7/9 at k=24 — see the spec's baseline table for the per-k detail and the decision-rule reading (mixed: raising k alone would fix most compound questions but not the original red-card failure, which stays incomplete even at k=24). Follow-through: that reading justified building query decomposition, spec'd and planned 2026-07-15 (Concept 19; PR #46) — execution pending.
- **A non-JSON failure response could strand the UI in "submitting" forever (issue #30).** Symptom: if `POST /api/ask` ever returned a failure that was neither a 401 nor JSON — a platform-level HTML 500, say — the Ask button would stay disabled with no error shown, recoverable only by a page reload. Investigation (caught by PR #27's fresh-context review, not by any per-task test): traced `hooks/useAskStream.ts`'s branching and found that after the 401 check and the `application/json` content-type branch, every remaining response was assumed to be an SSE stream — there was no `res.ok` check anywhere in the hook. Root cause: the SSE reader parses zero events from a non-SSE body, the read loop exits cleanly on `done`, and the function returns without ever dispatching an action, so the reducer's state simply never advances out of `submitting`. Fix: extracted the whole response-triage decision into a pure `classifyAskResponse(res)` function (`lib/ask-stream-response.ts`) that returns a `redirect | action | stream` outcome — pulling it out of the hook made the exact regression scenario (a real `Response` with a non-OK status and an HTML body) directly unit-testable, something it wasn't while the branching lived inline inside a `useCallback`. Prevention takeaway: a failure mode that's only reachable via live infrastructure failure is a sign the decision logic needs extracting into something a test can construct directly, not a sign it's untestable.
- **Gated and refused questions archived into visit history but expanded to blank content (issue #31).** Symptom: asking an off-topic question showed the correct decline message live, but after a second question pushed it into "Earlier this visit" and the user expanded it, the entry showed nothing. Investigation: the archive effect in `app/page.tsx` keeps any terminal state where `segments.length + chunks.length > 0` — gated responses carry their retrieved chunks, refused responses keep their `meta` chunks, so both pass that filter and get archived. Root cause: `components/HistoryList.tsx` only ever rendered `RulingCard` (returns null with no segments) and `LawPassages` (returns null with no passages) — neither the gate message nor the refusal copy was rendered anywhere in the expanded entry, so passing the archive filter and having something worth showing were two different conditions that nobody had made line up. Fix: a pure `historyEntryMessage(state)` selector (gated → `state.message`, refused → a shared `REFUSED_MESSAGE` constant, else → `null`) wired into `HistoryList.tsx`, mirroring how the live view already rendered those two phases. Prevention takeaway: "this state gets archived" and "this state has something to render when expanded" are two separate guarantees — a filter that decides what to keep isn't the same thing as coverage for what to show.

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
12. Empirical platform verification: a live probe reversed an assumed proxy-trust model.
13. Knowing which security controls are load-bearing vs. theater (the login-lockout non-fix).
14. UI genre honesty: reference desk over chat, because the API has no memory.
15. Accessible color needs the right role (a badge fill), not a duller shade.
16. Fresh-context final review catches cross-task bugs per-task review structurally can't.
17. Agentic-workflow process engineering: fixing rules at the source the day they're caught.
18. Removing an attack surface beats defending it: deny-all RLS with zero client credentials (ADR-001).
19. Known-limitation discipline: document and earmark eval cases for the compound-question recall gap instead of an unmeasured parameter bump.
20. Post-merge review findings cross into the issue tracker or they evaporate.
21. Deterministic hooks vs. advisory rules: telling apart the failure that needs a mechanical backstop from the one where the backstop would be the actual vulnerability.
22. Query decomposition: measure first, then design containment-first — parallel race for zero simple-case latency, fallback-to-baseline for zero regression surface, LLM output kept as data because it steers retrieval.

Full record of Part 2b's UI decisions (with rejected options): `docs/superpowers/specs/mockups/2026-07-12-part2b-ui-mockup.md`; design spec: `docs/superpowers/specs/2026-07-12-laws-rag-part2b-ui-deploy-design.md`.

---

## Glossary — every term this project uses, in plain English

> First vector project — these were all new words once. Each entry says what the term means in general AND what it specifically is in this project.

### Vectors & retrieval

- **Embedding / vector** — a list of numbers (here: produced by Voyage) that represents the *meaning* of a piece of text. Texts with similar meaning get numerically similar lists. "Vector" is just the math word for that list of numbers.
- **Embedding model** — the AI model that turns text into those numbers. Ours is Voyage `voyage-4-lite`. Critical rule: numbers from different embedding models can't be compared — all chunks *and* all questions must go through the same model.
- **Similarity (cosine similarity)** — a score for how close two embeddings are, roughly 0 (unrelated) to 1 (same meaning). Every retrieved chunk carries one; the relevance gate reads the best one.
- **Vector search (semantic search)** — find the stored texts whose embeddings are closest to the question's embedding. Finds "restarting the app" when you asked about "rebooting" — but is weak on exact identifiers like "Law 11".
- **Full-text (keyword) search** — classic word matching (Postgres built-in here). Strong exactly where vector search is weak: literal terms, names, numbers.
- **Hybrid search** — run both of the above and merge the results. This project does it inside one SQL function (`match_chunks`).
- **RRF (Reciprocal Rank Fusion)** — the merge formula for hybrid search: a document ranked high on *either* list scores well, computed from its rank positions (1st place is worth more than 5th), not its raw scores.
- **k / top-k** — how many chunks retrieval returns. Ours is k=8: the 8 best-ranked chunks go to Claude. The compound-question work measures when 8 isn't enough.
- **Chunk / chunking** — a slice of the source document, sized for retrieval. Ours are structure-aware: one chunk per numbered law section (118 chunks total), so every retrieved piece is a complete rule.
- **Breadcrumb** — a chunk's human-readable address, like `Law 12 › 2. Indirect free kick`. Citations and eval labels are expressed in breadcrumbs.
- **Corpus / corpus version** — the document collection being searched (here: one IFAB rulebook PDF), and its edition tag (`2025-26`) so a future season's rules can coexist without mixing.
- **RAG (Retrieval-Augmented Generation)** — the overall pattern: *retrieve* relevant passages first, then have the model *generate* an answer using only those passages, with citations as receipts.
- **Query decomposition** — the sketched-but-unbuilt fix for compound questions: use a cheap LLM call to split one multi-part question into simple sub-questions, retrieve for each, merge the results.
- **HNSW** — the index type pgvector uses to make vector search fast (an approximate nearest-neighbor graph). Trade-off: approximate means it can occasionally miss, and filtering after an approximate search can degrade recall.
- **pgvector** — the Postgres extension that adds a vector column type and similarity operators, letting the same database hold both the text and its embeddings.

### Evals (measuring retrieval quality)

- **Eval / eval harness** — an automated exam for the system: fixed questions with known correct answers, scored by a script (`npm run eval`), so "did my change help?" gets a number instead of a vibe.
- **Golden set** — the 30 core exam questions, each labeled with the law section(s) a correct answer must come from. Its 30/30 score is the regression gate: any change that drops it is rejected.
- **Recall@k** — "was a correct section anywhere in the top k results?" as a percentage across questions. Measures whether retrieval *found* the right material at all.
- **MRR (Mean Reciprocal Rank)** — measures *where* the first correct result ranked: 1st place scores 1, 2nd scores ½, 3rd scores ⅓, averaged over all questions. High MRR means the right chunk isn't just present but near the top.
- **Paraphrase tier** — the same topics as the golden set but asked in casual language, to check retrieval isn't just matching the rulebook's own vocabulary.
- **Abstain set** — off-topic questions (cricket, NBA) the system *should refuse*. Used to calibrate the relevance gate.
- **Relevance gate / `RELEVANCE_THRESHOLD`** — the pre-generation check: if the best retrieved similarity is below 0.35, don't call Claude at all — answer "I can only answer questions about the Laws of the Game." Saves money and blocks off-topic prompts before the model sees them.
- **Calibration** — choosing that threshold from measured data (the lowest score any real football question got vs. the highest score any off-topic question got) instead of guessing.
- **OR vs AND semantics** — golden questions count as answered if *any* expected section is found (OR). Compound questions are only fully answerable if *every* required section is found (AND) — which is why they needed their own tier and scoring function (`coverageScore`).
- **Baseline** — the recorded "before" numbers every future change is compared against.
- **Known-fail** — a test the current system is *expected* to fail, kept deliberately: it documents a limitation and will show progress if a fix ever lands.

### Generation (the answering side)

- **LLM / token** — the language model (Claude Haiku 4.5 here) and the word-fragments it reads and writes; API cost is per token, which is why retrieval sends 8 chunks, not the whole rulebook.
- **System prompt** — standing instructions the model gets before the user's question (here: "answer only from the provided documents, football only"). The user's question deliberately goes in a separate message, never pasted into these instructions.
- **Grounded generation** — the model answers from supplied documents, not from its own memory. The whole point of RAG.
- **Native citations** — a Claude API feature (`citations: {enabled: true}`): the API itself returns which document supports each answer span as structured data, instead of hoping the model formats `[1]` markers correctly in its prose.
- **SSE (Server-Sent Events) / streaming** — the answer arrives word-by-word over one long HTTP response as typed events (`meta`, `text`, `citation`, `refusal`, `done`, `error`) instead of one big blob at the end.
- **Refusal** — the model declining to answer (a formal stop reason in the API). The UI has an explicit branch for it — the source of the "blank ruling" bug the whole-branch review caught.
- **Prompt injection** — an attacker hiding instructions in text the model reads. In RAG the dangerous variant is instructions hidden *inside the documents* — structurally absent here because the corpus is one fixed official PDF nobody can write to.

### Guardrails & infrastructure

- **HMAC** — a cryptographic signature made with a secret key: anyone can *read* a signed value, but only the secret holder can *produce* a valid one. Our session cookies are `timestamp.HMAC(timestamp)` — stateless, no session table.
- **Domain separation** — prefixing what you sign (`session:` vs `pw:`) so a signature created for one purpose can never be replayed for another, even with the same secret.
- **Constant-time comparison** — comparing secrets in a way that takes the same time whether they match or not, so an attacker can't learn characters from response timing.
- **Rate limiting / spend ceiling** — usage caps: 20 questions/day per visitor, 500/day globally. The global one is the spend ceiling — the worst-case daily API bill is bounded no matter what.
- **RLS (Row Level Security)** — Postgres permissions at the row level. Ours is deny-all (enabled, zero policies): the database refuses direct reads entirely; only the server's privileged key gets through.
- **Service-role key vs anon key** — Supabase's two credential tiers: the all-powerful server-side key (never leaves the server; guarded by `import "server-only"`) vs. the browser-safe public key (this project deliberately ships none — see ADR-001).
- **RPC (in the Supabase sense)** — calling a SQL function by name from application code (`match_chunks`, `record_question`) instead of sending raw SQL. Both our retrieval and rate-limit logic live in DB functions so multi-step operations are atomic (can't be half-applied under concurrency).
- **Migration** — a numbered SQL file (`0001`–`0005`) that changes the database schema, kept in git so the database's history is reviewable code like everything else.
- **`x-forwarded-for` (XFF)** — the HTTP header that carries the client's IP through proxies. Which entry you can trust is platform-specific — the live probe that reversed our assumption (Concept 11) was about exactly this.
- **Edge / proxy** — the platform's front door that requests pass through before your code (Railway's edge; Next.js's `proxy.ts` is our own in-app gate that checks the session cookie).
- **Idempotent** — safe to run twice with the same end result. The ingestion pipeline is idempotent per corpus version: re-running it can't duplicate chunks.
