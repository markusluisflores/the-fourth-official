# Retro: npm audit CI failure on unrelated PR (issue #80)

**Date:** 2026-07-22
**Type:** incident
**Status:** resolved

---

## What Went Right

- **Root-caused properly instead of patching blind.** The obvious shortcut — run `npm audit fix --force` and take whatever it suggests — would have downgraded `next` from `16.2.10` to `9.3.3`, a 7-major-version regression. Actually checking what `--force` proposed (via `npm view` against the real registry) caught that npm's own suggested fix path was a false lead before it was applied, not after.
- **Verified against a real production build, not just `tsc`/`vitest`/`audit`.** The version overrides touch `postcss` (CSS processing) and `sharp` (image optimization) — exactly the kind of dependency where a type check and unit tests would stay green while something breaks silently at build or render time. Running `npm run build` (real Turbopack production build) before considering this done caught nothing wrong, but it was the right thing to check, not an assumption.
- **Kept scope clean.** Confirmed via `git diff` against the merge-base that the CI failure had zero relationship to issue #65's in-flight PR, and gave it its own issue (#80) and its own PR (#81) rather than bundling an unrelated dependency fix into a feature PR under review.
- **Two independent fresh-context reviews, both real.** The second review specifically re-checked whether the registry state had drifted since the first pass (it hadn't) and independently ran the same production build check rather than trusting the first review's report of it.
- **Pushed back on one finding instead of applying it reflexively.** The second review's NIT suggested caret ranges instead of exact version pins for the two overrides. Exact pins were kept deliberately — for a security-CVE-driven override, controlling exactly which version is trusted is the point; a caret range would let a future `npm install` silently drift to an unreviewed later version. Recorded as a considered decision, not an oversight.

## What Went Wrong

- **The failure was discovered by luck of timing, not by any monitoring.** These advisories were newly disclosed to the npm advisory database sometime between the last clean CI run (2026-07-21) and this PR's CI run (2026-07-22) — a pure coincidence that an unrelated PR's CI happened to run in that window and surface it. Nothing in this project watches for newly-disclosed advisories against dependencies that haven't changed; the only detection mechanism is "did a PR's CI happen to run recently."
- **`npm audit`'s own suggested `--force` fix is actively misleading** and would have been a serious regression if applied without checking (semver-range resolution surfaced the numerically-lowest non-vulnerable version, not the nearest one). This is a real npm tooling gap, not something this project can fix, but it means "just run the suggested fix" is not a safe default here.
- **The overrides are a workaround, not a real fix, with no expiry mechanism.** `postcss`/`sharp` are pinned ahead of what `next` itself has published a stable fix for. Nothing will surface it again when Next.js does ship the fix — the pins will just sit there indefinitely unless someone remembers to check.

## What We Can Improve

- The project could run `npm audit --audit-level=high` on a schedule (not just on PR pushes) so a newly-disclosed advisory against an already-merged, unchanged dependency tree gets caught within a day, not whenever the next unrelated PR happens to open.
- The removal-trigger note added to issue #80 (check `npm view next@latest dependencies.postcss optionalDependencies.sharp` periodically, drop the overrides once a stable release patches both) is a manual mitigation for the "no expiry" gap — a Dependabot-style automated check would be more reliable than remembering to look, but wasn't built here since it's out of scope for a single bug fix.
- Worth generalizing the "verify with a real build, not just type-check and unit tests" lesson beyond this one incident: any dependency version change that touches build-time or render-time tooling (CSS processors, image/asset pipelines, bundlers) should get a real `npm run build` check as a matter of course, not just when someone happens to think of it.

## Action Items

| Item | Status |
|---|---|
| Periodically check `npm view next@latest dependencies.postcss optionalDependencies.sharp` and drop the `overrides` once a stable Next.js release ships the fix (tracked on issue #80) | Pending |
| Consider a scheduled (not just on-push) `npm audit` CI job so newly-disclosed advisories against unchanged dependencies surface proactively instead of by coincidence | Pending |
| Add "run a real `npm run build` when a dependency change touches build/render tooling" as a standing check, not an ad hoc one — candidate for `docs/standards.md` or the Node.js quality baseline | Pending |
