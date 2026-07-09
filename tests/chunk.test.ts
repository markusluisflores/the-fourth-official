import { describe, expect, it } from "vitest";
import { chunkRulebook, MAX_CHUNK_CHARS } from "../scripts/ingest/chunk";

const FIXTURE = `
LAW 11 OFFSIDE
1. Offside position
It is not an offence to be in an offside position.
2. Offside offence
A player in an offside position is penalised if involved in active play.

LAW 12 FOULS AND MISCONDUCT
1. Direct free kick
A direct free kick is awarded for careless challenges.
`.trim();

describe("chunkRulebook", () => {
  it("creates one chunk per numbered section with a breadcrumb", () => {
    const chunks = chunkRulebook(FIXTURE);
    const crumbs = chunks.map((c) => c.breadcrumb);
    expect(crumbs).toContain("Law 11 › 1. Offside position");
    expect(crumbs).toContain("Law 11 › 2. Offside offence");
    expect(crumbs).toContain("Law 12 › 1. Direct free kick");
  });

  it("tags chunks with their law number", () => {
    const chunks = chunkRulebook(FIXTURE);
    expect(chunks.find((c) => c.breadcrumb.startsWith("Law 12"))!.lawNumber).toBe(12);
  });

  it("keeps section body text in the chunk content", () => {
    const offside = chunkRulebook(FIXTURE).find(
      (c) => c.breadcrumb === "Law 11 › 2. Offside offence",
    )!;
    expect(offside.content).toContain("active play");
  });

  it("splits oversized sections at paragraph boundaries, keeping the breadcrumb", () => {
    const bigBody = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(60)}.`).join(
      "\n\n",
    );
    const text = `LAW 3 THE PLAYERS\n1. Number of players\n${bigBody}`;
    const chunks = chunkRulebook(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.every((c) => c.breadcrumb.startsWith("Law 3 › 1. Number of players"))).toBe(true);
  });

  it("puts pre-section law text into a section-0 chunk", () => {
    const text = `LAW 5 THE REFEREE\nGeneral authority statement.\n1. Powers\nThe referee has full authority.`;
    const crumbs = chunkRulebook(text).map((c) => c.breadcrumb);
    expect(crumbs).toContain("Law 5 › Introduction");
  });
});
