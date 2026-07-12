# Part 2b UI — Design Process Record & Mockups

> Working document for the 2026-07-12 design-process session (Fable). Captures the
> mandatory three-step design process (consistency audit → platform research →
> ui-ux-pro-max) and the design options. The `## Decisions` table is filled in as
> Markus resolves each question; nothing here is final until it appears there.

## Step 1 — Consistency audit (no UI exists; binding patterns come from elsewhere)

- **Styling stack:** Tailwind 4 (`@theme` in `globals.css`), Geist Sans/Mono wired in
  `layout.tsx`, light/dark via `prefers-color-scheme` with `--background`/`--foreground`
  tokens. Scaffold quirk to fix in 2b: `globals.css` body rule overrides Geist with Arial.
- **Copy voice (fixed by Part 2a API + system prompt):** plain, honest, referee-neutral —
  "You've used all 20 questions for today — come back tomorrow", "I can only answer
  questions about the Laws of the Game". Persona already named: **The Fourth Official**.
- **API contract the UI consumes:** JSON `kind: "gated" | "rate_limited"` (+`scope`),
  SSE `meta`/`text`/`citation`/`refusal`/`done`/`error`, `remaining.visitor` in `meta`
  and gated responses, 401 → show gate.
- **Interaction model fixed by the API: one-shot Q&A.** Each POST is stateless — no
  conversation history, no follow-ups. A chat costume would falsely advertise memory.

## Step 2 — Platform research (citation-forward answer products, 2026)

- Inline numbered markers preserving the claim-to-source bond (Perplexity) are the
  genre standard; sentence-end-only links (ChatGPT) are less granular.
- Dual interaction mode: hover for a short preview, click to reach the full source.
- Panels/drawers for deeper exploration; inline cues for sentence-level claims.
- Point to **exact passages**, not whole documents — exactly what Part 2a's native
  citations provide (`cited_text` + char offsets).
- Make missing/broken citations explicit (maps to our `refusal`/gated states).
- "Consistency over visual polish."
- Sources: shapeof.ai/patterns/citations, aydesign.ai AI-citation patterns 2026,
  aiuxplayground.com Perplexity teardown.

## Step 3 — ui-ux-pro-max design system

- **Product-type match:** Knowledge Base/Documentation → "Minimalism + Accessible &
  Ethical", alt "Swiss Modernism 2.0, Flat Design", search-first, clean hierarchy +
  minimal color. Legal Services row confirms the authority register (trust, credibility).
- **Chosen style direction: Swiss Modernism 2.0** — strict grid, high contrast,
  mathematical spacing, **single vibrant accent**, no decoration. WCAG AAA-capable,
  Tailwind 10/10, explicitly "best for editorial/documentation". Rejected: Dark-Mode
  developer-tool styling (wrong audience), Magazine/editorial pink (wrong register).
- **Palette (domain-native semantics — referee's kit):**
  - ■ `#FFFFFF` / `#0A0A0A` — background light/dark (existing scaffold tokens)
  - ■ `#171717` / `#EDEDED` — foreground light/dark (existing scaffold tokens)
  - ■ `#15803D` (light) / `#22C55E` (dark) — **pitch green**, the single accent: primary
    action, links, citation markers. (green-700 for light mode: ≥4.5:1 on white; the
    brighter green-500 only on dark.)
  - ■ `#FACC15` — **yellow card** (revised per Markus, 2026-07-12: `#B45309` amber "did not
    look like a yellow card"): true card yellow used as a **fill** on a card-shaped badge
    (small rounded portrait rectangle, `#171717` text beside it), never as text color on
    white. If yellow-toned *text* is ever unavoidable in light mode, `#A16207` is the
    AA-compliant fallback — but the identity lives in the card glyph.
  - ■ `#DC2626` (light) / `#F87171` (dark, text) — **red card**: errors, refusals; same
    card-glyph badge treatment (`#DC2626` fill both themes) for consistency
- **Type:** Geist Sans for prose/UI; **Geist Mono for the "law register"** — breadcrumbs
  (`Law 15 › 1`), citation markers, similarity scores. The mono voice = quoting the book.
- Key UX rules flagged for implementation: 44px touch targets, visible focus rings,
  `aria-live` for streamed/async status, skeleton over spinner >300ms, reduced-motion
  support, `min-h-dvh`, one primary CTA per screen.

## Options — ask screen identity

### Option A — "Reference desk" (single column, ruling card) ✅ CHOSEN

```
┌────────────────────────────────────────────────────────────┐
│ THE FOURTH OFFICIAL      Laws of the Game 2025/26     18/20│
├────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────┐  ┌───────┐  │
│  │ Can a goal be scored straight from a      │  │  Ask  │  │
│  │ throw-in?                                 │  └───────┘  │
│  └───────────────────────────────────────────┘             │
│                                                            │
│  THE RULING                                                │
│  ───────────────────────────────────────────────────────   │
│  No — a goal cannot be scored directly from a throw-in     │
│  [1]. If the ball enters the opponents' goal, play         │
│  restarts with a goal kick [1][2]. ▌            streaming  │
│                                                            │
│  WHAT THE LAW SAYS                                         │
│  [1] Law 15 › 1  The throw-in                              │
│      │ "A goal cannot be scored directly from a throw-in"  │
│  [2] Law 15 › 3  Offences and sanctions                    │
│      │ "…the game is restarted with a goal kick"           │
│                                                            │
│  ▸ How this answer was built · 8 passages retrieved        │
│                                                            │
│  EARLIER THIS VISIT                                        │
│  • Is offside from a corner possible?              ▸       │
└────────────────────────────────────────────────────────────┘
```

One question at a time; the answer is a **ruling**, not a message. Cited passages
sit directly under the answer (exact quotes, mono breadcrumbs). Glass box is a
collapsible drawer. Earlier questions from this visit collapse into a compact
client-side list (page state only — refresh clears it; matches the stateless API).

### Option B — Chat transcript

```
┌────────────────────────────────────────────────────────────┐
│ THE FOURTH OFFICIAL                                   18/20│
├────────────────────────────────────────────────────────────┤
│                       ┌────────────────────────────────┐   │
│                       │ Can a goal be scored straight  │ ⦿ │
│                       │ from a throw-in?               │   │
│                       └────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐                  │
│  │ No — a goal cannot be scored         │                  │
│  │ directly from a throw-in [1]…        │                  │
│  │ ▸ sources (2)   ▸ how it was built   │                  │
│  └──────────────────────────────────────┘                  │
│  ┌───────────────────────────────────────────┐ ┌───────┐   │
│  │ Type a message…                           │ │  Send │   │
│  └───────────────────────────────────────────┘ └───────┘   │
└────────────────────────────────────────────────────────────┘
```

Familiar streaming-answer genre. **Rejected by the consistency audit unless chosen
consciously:** the API has no memory — a transcript with a "Type a message…" box
advertises follow-up context that doesn't exist ("chatbot living inside a rules
reference"). Sources demoted to disclosure links weakens the citations-first identity.

### Option C — Two-pane workbench (answer left, sources rail right)

```
┌────────────────────────────────────────────────────────────┐
│ THE FOURTH OFFICIAL                                   18/20│
├──────────────────────────────┬─────────────────────────────┤
│ ┌─────────────────────┐ ┌───┐│ SOURCES            8 found  │
│ │ Can a goal be…      │ │Ask││ ✓[1] Law 15 › 1   0.87      │
│ └─────────────────────┘ └───┘│ ✓[2] Law 15 › 3   0.74      │
│                              │  [3] Law 10 › 1   0.61      │
│ THE RULING                   │  [4] Law 8 › 2    0.55      │
│ No — a goal cannot be        │  …                          │
│ scored directly from a       │ (✓ = cited in the answer)   │
│ throw-in [1]. Play restarts  │                             │
│ with a goal kick [1][2].     │                             │
└──────────────────────────────┴─────────────────────────────┘
```

Perplexity-style research desk; glass box permanently visible. Costs: reads as an
"AI search engine" rather than a rulebook; the always-on rail dilutes the
"How this answer was built" reveal; needs a second mobile layout (rail → stacked),
noticeably more build than A for the same information.

## Citation interaction (Q3 — decided: click-to-scroll)

```
click [1] in the ruling  →  page scrolls to the passage under WHAT THE LAW SAYS
                            and flashes a brief pitch-green highlight (~1s fade)
```

Markers are buttons (`aria-label="Show cited passage 1"`), ≥44px touch target via
padding, `scroll-behavior: smooth` gated on `prefers-reduced-motion`, flash color =
accent green at low opacity so foreground text contrast is unaffected mid-flash.

## Gate screen (same in all options — not an identity question)

```
┌────────────────────────────────────────────┐
│                                            │
│            THE FOURTH OFFICIAL             │
│     Rulings from the Laws of the Game      │
│                                            │
│   This is a private demo.                  │
│   ┌──────────────────────────┐ ┌───────┐   │
│   │ Password                 │ │ Enter │   │
│   └──────────────────────────┘ └───────┘   │
│   (wrong password → red-card text below    │
│    the field, field keeps focus)           │
│                                            │
└────────────────────────────────────────────┘
```

## Decisions

| Question | Chosen | Why | Tradeoff accepted |
|---|---|---|---|
| Q1 — Ask-screen identity (A reference desk / B chat / C workbench) | **Option A — reference desk** (Markus, 2026-07-12) | Only shape that matches the stateless one-shot API; answer framed as a ruling; citations stay the hero | Gives up the familiar chat affordance; no follow-up illusion |
| Q2 — Same-visit history (a collapsed list / b replace-last / c stacked feed / d a+sessionStorage) | **(a) collapsed client-side list** (Markus, 2026-07-12); (d) sessionStorage persistence approved as a future upgrade, not in the v1 build | Re-opening a ruling is free; re-asking costs one of 20 daily questions | Extra client state + one more component; history lost on refresh until (d) lands |
| Q3 — Citation interaction: (i) click-to-scroll vs (ii) hover-preview + click | **(i) click-to-scroll** with ~1s pitch-green highlight flash on the target passage (Markus, 2026-07-12) | Sources are already on-screen directly beneath the answer — a hover popover would preview content one glance away; (i) is identical on desktop and mobile | No hover preview for desktop users; add (ii) only if sources ever move off-screen |
| Q4 — Glass-box default state (x always collapsed / y open on first answer then remember toggle / z always open) | **(y) open on first answer of the visit, remember the user's toggle after** (Markus, 2026-07-12) | The glass box is the portfolio differentiator — one guaranteed exposure without nagging; user keeps control | First answer is visually busier; needs one bit of client toggle state |
| Q5 — Color scheme (1 referee's kit / 2 FM-inspired / 3 navy+gold) — rendered options: `2026-07-12-part2b-palette-options.pdf` | **Option 1 — referee's kit, with yellow-card revision** (Markus, 2026-07-12): true card yellow `#FACC15` as card-shaped badge fill, not amber text | Domain-native semantics, original interview story; badge treatment keeps true yellow AND accessibility | FM brand nod given up; yellow never appears as text color |

## Build guidance for the Part 2b spec/plan (must carry into implementation tasks)

- Every UI implementation task must invoke the built-in `frontend-design` skill before
  writing or styling components (decided 2026-07-12; ui-ux-pro-max was research-time
  only — see design-process skill's "Handoff to implementation" section).
- The rendered palette artifacts (`…-palette.pdf`, `…-palette-options.pdf`) are the
  color source of truth once Q5 is decided; hex values go into `globals.css` `@theme`
  tokens, never raw in components.

## Session-state note (in case of session hand-off)

Completed this session: PR #16 reviewed (approve, comment posted), guardrail rulings
recorded (memory `part2b-deploy-blockers`), subagent-dispatch process fix applied
(skill template + global CLAUDE.md), journal backfilled + pushed (`ef081d2`), Obsidian
capture done (3 concepts + 1 experience). Part 2b brainstorm: scope confirmed
(screens + deploy w/ blockers + ride-along cleanups; prompt-injection and issue-spam
excluded), design process steps 1–3 done (this file). Next: Markus answers Q1–Q4 →
design presented in sections → spec at `docs/superpowers/specs/2026-07-12-laws-rag-part2b-ui-deploy-design.md`
→ `superpowers:writing-plans`. Reviewer-guide note: PR #16 already carries the Part 2a
section of `docs/project-reviewer.md`; this session's review rulings still need an
interview-prep capture pass after merge.
