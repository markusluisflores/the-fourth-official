# Retro: Mid-Execution Plan Revision Committed Directly to the Execution Branch

**Date:** 2026-07-16
**Type:** process
**Status:** resolved

---

## What Went Right

- The escalation itself was handled correctly: when Task 3's task review found the plan's own reference code (`Promise.all([searchChunks, decompose])`) blocked every request on decompose's full latency, the controller stopped and escalated to `superpowers:brainstorming` instead of patching the implementer's diff ad hoc or overriding the finding.
- The resulting **spec** revision was handled exactly right — a dedicated `docs/decompose-timing-redesign` branch, opened as its own PR (#49), reviewed by Fable across three genuine rounds (each with real findings fixed), and merged cleanly before any further code was touched.
- Multiple independent review layers caught real defects before anything shipped: a task-review pass caught the original latency bug; Fable's design review caught a BLOCKER + refinement in the soft-deadline mechanism; a later Fable plan review caught a WebCrypto/fake-timers test hang and a dropped measurement requirement; a genuinely fresh-context (non-resumed) review caught a rate-limit bug in a new script and a real sequencing gap (Task 4 skipped). Each layer found something the previous one missed.
- The self-approval risk in the review loop (resuming the same Fable agent thread and using leading "confirm this fix" prompts) was caught mid-session — by the human noticing the pattern, and confirmed by the harness's own security-warning tooling — and corrected by dispatching genuinely fresh, neutrally-framed reviews for the remainder of the process.
- Nothing had merged to `main` by the time this was caught. The blast radius was contained to one execution branch's history, not shipped code.
- The Task 5 implementer, upon hitting a real acceptance-bar failure (the soft-deadline miss rate), stopped and escalated with four concrete options rather than picking an arbitrary constant or fudging the numbers — correctly treating it as a design-level judgment call, not a tuning knob to push through alone.

## What Went Wrong

- Immediately after PR #49 (the spec revision) merged, the **implementation plan** revision — translating the new spec into concrete Task 3 route code and Task 5 measurement steps — was committed directly onto `feat/query-decomposition`, the in-progress execution branch, instead of going through its own dedicated `docs/` branch and review cycle.
- **Root cause:** this was a genuine inconsistency, not a one-off slip. The spec revision got dedicated-branch treatment because `superpowers:brainstorming`'s own process demands it. Nothing in either `superpowers:brainstorming` or `superpowers:writing-plans` extends that same discipline to a plan document that needs revision *after* execution has already begun — both skills implicitly assume a plan is authored once, up front, then executed straight through. There was no explicit checklist item prompting "does this plan revision also need its own branch," so it didn't get one.
- **Contributing factor:** momentum. Having just correctly handled the spec through its own branch, attention shifted straight back to "resume executing Task 3," and the plan-document update in between was treated as a mechanical translation step rather than a second design artifact needing its own review gate — even though it contained exactly the kind of subtle async/timing logic (the elapsed-aware race, two new fake-timer tests) that had already proven easy to get wrong once.
- **Consequence:** two real BLOCKERs were later found *in the plan revision itself* (a WebCrypto/fake-timers hang, a measurement requirement silently dropped), proving after the fact that it needed the same rigor as the spec. By then, reviewing it meant either resuming an already-contaminated Fable thread (a related but separate problem) or opening the execution branch itself as the review PR — which is what actually happened (PR #50), mixing in-progress feature code (Tasks 1-4) with active design revision in a single branch.
- This forced an expensive unwind once a *third* design-level finding surfaced (the soft-deadline latency/threshold mismatch discovered during Task 5): there was no way to cleanly isolate "the parts of the branch that are done and stable" from "the part still under design revision" without either merging incomplete work to `main` or further tangling the same branch — exactly the stacking problem the human flagged.

## What We Can Improve

- Generalize the existing spec-revision pattern explicitly to plan revisions, and to "revision" generally — not just first drafts: any change to an already-committed spec or plan document gets its own dedicated `docs/` branch and review cycle, whether that happens at initial design time or is triggered by an execution-time finding.
- When mid-execution on a `feat/` branch, that revision branch should come off the `feat/` branch itself (not `main`) and merge back into it — so nothing touches `main` prematurely, but the revision still gets isolated, reviewable treatment instead of landing directly on the execution branch's own history.
- Make the checkpoint explicit at the moment a redesign is triggered, not something reasoned about only after a second review round proves it was needed: the instant a task-review or independent-review finding requires a spec/plan-level change (not just an implementation fix), the controller should ask "does this need its own docs branch" as a mandatory checklist item, before touching any files.
- Since prose-only rules are easy to skip under momentum (as happened here), operationalize the rule directly in the skill that's active when this scenario arises (`subagent-driven-development`'s BLOCKED/escalation handling), not just in CLAUDE.md prose — matching how this project already treats mechanizable process gaps.

## Action Items

| Item | Status |
|---|---|
| Add durable cross-project rule to global CLAUDE.md (Global conventions): spec/plan revisions — initial or mid-execution — always get a dedicated `docs/` branch, never committed directly to the execution branch | Done |
| Patch `superpowers:subagent-driven-development` SKILL.md (BLOCKED handling, item 4) to state this explicitly, with the branch-off-`feat/`-not-`main` nuance for mid-execution cases | Done |
| Register the patch in `plugin-local-patches.md` (Patch 3) so it survives a plugin update | Done |
| Untangle PR #50: discard the uncommitted, unvalidated Task 5 WIP; do not merge Tasks 1-4 into `main` yet | Pending |
| Create a new `docs/` branch off `feat/query-decomposition` (not `main`) for the soft-deadline latency/threshold design decision that Task 5's measurement surfaced; open it as a PR targeting `feat/query-decomposition`; run it through the same brainstorming + Fable review process | Pending |
| Resume Task 5 on `feat/query-decomposition` once that design decision merges back in, using the real decided values | Pending |
