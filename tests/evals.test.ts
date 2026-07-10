import { describe, expect, it } from "vitest";
import { scoreQuestion } from "../evals/run-evals";

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
