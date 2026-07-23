# Retro: Second npm audit CI failure in two days — new CVEs in `next` itself (issue #86)

**Date:** 2026-07-23
**Type:** incident
**Status:** resolved

---

## What Went Right

- **Root cause confirmed with hard evidence before proposing a fix.** `npm audit --audit-level=high --json` was read directly, not just the human-readable summary — every one of the 9 advisories carried the identical `"range": ">=16.0.0 <16.2.11"` field, and `npm view next@16.2.11 version time.16.2.11` confirmed it was a real, already-published release. Unlike issue #80's `npm audit fix --force` (a misleading 7-major-version-downgrade suggestion from a resolver quirk), this time the suggested fix was checked against the advisory data itself before trusting it — and it held up.
- **Verified with a real production build again, deliberately, not by habit alone.** `npm run build` succeeded, including the Turbopack build of `proxy.ts` middleware — directly relevant since one of the 9 CVEs was specifically a middleware/proxy bypass under Turbopack. This is the same "build-time/render-time tooling needs a real build check, not just typecheck+audit" lesson from issue #80's retro, applied on purpose the second time rather than rediscovered.
- **Scope stayed clean.** The CVE fix was pulled out of the unrelated PR #85 (docs-only) where it was discovered, given its own issue (#86) and its own PR (#87), matching issue #80's precedent exactly.
- **The review-dispatch decision was made deliberately, not by default.** Before spending on an AI review round, Markus asked directly whether one would add value for this specific change. The honest answer — mostly no, since the fix has no judgment surface (the exact patched version is stated directly in the advisory data, and the fix was already verified against objective facts) — was given instead of dispatching reflexively because "that's what we do for PRs." One round was still run, at Markus's explicit request, out of genuine curiosity rather than policy — and it found nothing that needed fixing.
- **Post-merge issue-close verification held again.** The commit used the literal, adjacent `Fixes #86` syntax; `gh issue view 86` confirmed it auto-closed correctly. No third occurrence of the #64/#65 phrasing bug.

## What We Can Improve

- **The independently-run AI review round re-derived the exact same "add a scheduled audit job" suggestion as issue #80's retro** — with zero knowledge of that retro's existence. Two separate incidents, two separate reasoning processes (a retro write-up and a fresh Opus review, one day apart), converging on the identical gap. That's a stronger signal than either alone that this is worth actually building, not filing a third time as "worth considering."
- **This is the second time in two days a newly-disclosed CVE was caught purely by an unrelated PR's CI happening to run in the right window.** Issue #80's retro already named this exact failure mode; it recurred verbatim, on a different package, one day later. A logged gap that isn't acted on doesn't stop recurring just because it's already been logged once — the retro from issue #80 was correct and complete, and the gap it named still bit the project again the next available opportunity.
- **Opened a new, related process question, not yet decided:** is there a principled way to tell, before dispatching, whether a change has enough judgment surface to warrant a review round at all — versus a change (like this one) that's already fully determined by objective, checkable facts? This is distinct from the still-deferred fresh-vs-resumed and parallel-vs-sequential questions tracked in `FABLE-HANDOFF.md` — it's "should a round happen at all," not "what shape should the round take." Logged as a candidate third axis for the eventual PR/code-review process design session, not answered here.

## Action Items

| Item | Status |
|---|---|
| Build the scheduled (cron-triggered) `npm audit --audit-level=high` CI job — no longer "worth considering," now reinforced by two same-day-adjacent independent incidents converging on the same gap | Pending |
| Decide the failure UX for the scheduled job (auto-file an issue on a new advisory, vs. a notification-only red run) as part of building it, not as a separate follow-up | Pending |
| Fold this incident's outcome back into the still-open "consider scheduled audit CI" item from issue #80's retro rather than tracking it as a fresh, separate item — same gap, second confirmation | Pending |
| Surface the "does this change have a judgment surface at all" question to the eventual PR/code-review process design session, alongside fresh-vs-resumed and parallel-vs-sequential | Pending |
