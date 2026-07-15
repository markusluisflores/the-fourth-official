import { describe, expect, it } from "vitest";
import { coverageScore, matchesExpected, scoreQuestion } from "../evals/run-evals";

const crumbs = (...b: string[]) => b.map((breadcrumb) => ({ breadcrumb }));

describe("scoreQuestion", () => {
  it("returns the 1-based rank of the first expected match", () => {
    expect(
      scoreQuestion(crumbs("Law 3 › 1. Players", "Law 11 › 1. Offside position"), ["Law 11 › 1"]),
    ).toBe(2);
  });

  it("matches on prefix", () => {
    expect(scoreQuestion(crumbs("Law 15 › 2. Infringements"), ["Law 15"])).toBe(1);
  });

  it("returns 0 when nothing matches", () => {
    expect(scoreQuestion(crumbs("Law 1 › 1. Field surface"), ["Law 11 › 1"])).toBe(0);
  });

  it("honours any of several expected sections", () => {
    expect(
      scoreQuestion(crumbs("Law 12 › 3. Disciplinary action"), ["Law 12 › 2", "Law 12 › 3"]),
    ).toBe(1);
  });
});

describe("matchesExpected", () => {
  it("matches an exact breadcrumb", () => {
    expect(matchesExpected("Law 12 › 3", "Law 12 › 3")).toBe(true);
  });

  it("matches a section prefix followed by its title", () => {
    expect(matchesExpected("Law 12 › 3. Disciplinary action", "Law 12 › 3")).toBe(true);
  });

  it("matches a bare law prefix followed by a section separator", () => {
    expect(matchesExpected("Law 15 › 2. Infringements", "Law 15")).toBe(true);
  });

  // Regression for the PR #1 review finding: "Law 1" must NOT match Laws 10-17.
  it("does not match a longer law number sharing a digit prefix", () => {
    expect(matchesExpected("Law 11 › 1. Offside position", "Law 1")).toBe(false);
    expect(matchesExpected("Law 12 › 30. Hypothetical", "Law 12 › 3")).toBe(false);
  });
});

describe("coverageScore", () => {
  it("reports full coverage when every required section is present", () => {
    const result = coverageScore(
      crumbs("Law 3 › 1. Number of players", "Law 10 › 2. Winning team"),
      ["Law 3 › 1", "Law 10 › 2"],
    );
    expect(result).toEqual({ coverage: 1, missed: [] });
  });

  it("names the missed sections and computes the found fraction", () => {
    const result = coverageScore(
      crumbs("Law 3 › 1. Number of players", "Law 12 › 4. Disciplinary action"),
      ["Law 3 › 1", "Law 10 › 2", "Law 10 › 3"],
    );
    expect(result.missed).toEqual(["Law 10 › 2", "Law 10 › 3"]);
    expect(result.coverage).toBeCloseTo(1 / 3);
  });

  it("counts a section found once even when several chunks match it", () => {
    const result = coverageScore(
      crumbs(
        "Law 10 › 3. Penalties (penalty shoot-out)",
        "Law 10 › 3. Penalties (penalty shoot-out)",
      ),
      ["Law 10 › 3"],
    );
    expect(result).toEqual({ coverage: 1, missed: [] });
  });

  it("uses segment-aware matching, not raw prefixes", () => {
    // "Law 1" must not be satisfied by a Law 11 chunk (matchesExpected semantics)
    const result = coverageScore(crumbs("Law 11 › 1. Offside position"), ["Law 1"]);
    expect(result).toEqual({ coverage: 0, missed: ["Law 1"] });
  });

  it("returns full coverage vacuously for an empty required list", () => {
    expect(coverageScore(crumbs("Law 9 › 1. Ball out of play"), [])).toEqual({
      coverage: 1,
      missed: [],
    });
  });

  it("misses everything when there are no chunks", () => {
    expect(coverageScore([], ["Law 3 › 1"])).toEqual({ coverage: 0, missed: ["Law 3 › 1"] });
  });
});
