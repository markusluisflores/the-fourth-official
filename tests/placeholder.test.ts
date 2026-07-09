import { describe, expect, it } from "vitest";

// Vitest exits non-zero when zero test files match `include` (no `passWithNoTests`
// configured in vitest.config.ts, per the plan's exact config). This placeholder keeps
// `npm test` green until Task 2 adds the first real test file — safe to delete then.
describe("bootstrap", () => {
  it("test runner is wired up", () => {
    expect(1 + 1).toBe(2);
  });
});
