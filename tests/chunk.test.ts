import { describe, expect, it } from "vitest";
import {
  assertCompleteLawSet,
  chunkRulebook,
  MAX_CHUNK_CHARS,
  type RawChunk,
} from "../scripts/ingest/chunk";

// The live PDF (extracted via unpdf, one page per array entry, joined with "\n") renders
// each chapter divider as "Law" and the bare number on their own consecutive lines — the
// spelled-out title ("OFFSIDE") is a stylized graphic and isn't extractable as plain text.
// Found running `npm run ingest` against data/laws-2025-26.pdf, which produced 0 chunks
// against the original single-line "LAW 11 OFFSIDE" fixture below.
const FIXTURE = `
Law
11
1. Offside position
It is not an offence to be in an offside position.
2. Offside offence
A player in an offside position is penalised if involved in active play.

Law
12
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
    const text = `Law\n3\n1. Number of players\n${bigBody}`;
    const chunks = chunkRulebook(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.every((c) => c.breadcrumb.startsWith("Law 3 › 1. Number of players"))).toBe(true);
  });

  it("puts pre-section law text into a section-0 chunk", () => {
    const text = `Law\n5\nGeneral authority statement.\n1. Powers\nThe referee has full authority.`;
    const crumbs = chunkRulebook(text).map((c) => c.breadcrumb);
    expect(crumbs).toContain("Law 5 › Introduction");
  });

  // Regression for the two-line live-PDF divider format: a lone "Law" line not
  // immediately followed by a bare number line (e.g. a body reference like "see Law")
  // must not be mistaken for a chapter divider.
  it("does not treat a stray 'Law' line as a divider unless followed by a bare number", () => {
    const text = `Law\n11\n1. Offside position\nSee also Law\nfor related offences in other laws.`;
    const chunks = chunkRulebook(text);
    expect(chunks.every((c) => c.lawNumber === 11)).toBe(true);
  });

  // Real gap: unpdf's extracted text has no blank-line paragraph breaks at all — every
  // "paragraph" comes through as a run of single-newline-separated wrapped lines. The
  // synthetic oversize-split fixture above joins paragraphs with "\n\n", which never
  // occurs in the live PDF, so splitOversize's `body.split(/\n\n+/)` saw the whole
  // section as one unsplittable "paragraph" and let a 12,916-char chunk through — 8.6x
  // MAX_CHUNK_CHARS. Found by inspecting chunkRulebook() output against
  // data/laws-2025-26.pdf (Law 12 › 4. Disciplinary action).
  it("splits an oversized section at line boundaries when it has no blank-line paragraph breaks", () => {
    const bigBody = Array.from({ length: 100 }, (_, i) => `Line ${i} ${"x".repeat(30)}.`).join(
      "\n",
    );
    const text = `Law\n12\n4. Disciplinary action\n${bigBody}`;
    const chunks = chunkRulebook(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.every((c) => c.breadcrumb === "Law 12 › 4. Disciplinary action")).toBe(true);
    // no content lost across the split
    expect(chunks.map((c) => c.content).join(" ")).toContain("Line 0 ");
    expect(chunks.map((c) => c.content).join(" ")).toContain("Line 99 ");
  });
});

// Guards against Finding 1 from the Task 6 review: divider detection (both here and in
// parse.ts) has no semantic guard — any "Law" line followed by a bare 1-2 digit line is
// treated as a real chapter divider, with no range or ordering check. A coincidental
// match anywhere in the real ~230-page document (a table-of-contents entry, an index
// reference, a stray caption) would silently corrupt the corpus. assertCompleteLawSet is
// the backstop, run from index.ts's main() after chunking, before embedding/upserting.
describe("assertCompleteLawSet", () => {
  const chunkFor = (lawNumber: number): RawChunk => ({
    lawNumber,
    breadcrumb: `Law ${lawNumber} › Introduction`,
    content: "content",
  });

  it("does not throw when law numbers 1-17 are all present exactly once", () => {
    const chunks = Array.from({ length: 17 }, (_, i) => chunkFor(i + 1));
    expect(() => assertCompleteLawSet(chunks)).not.toThrow();
  });

  it("does not throw when a law has multiple chunks, as long as 1-17 are all present", () => {
    const chunks = [
      ...Array.from({ length: 17 }, (_, i) => chunkFor(i + 1)),
      chunkFor(11),
      chunkFor(11),
    ];
    expect(() => assertCompleteLawSet(chunks)).not.toThrow();
  });

  it("throws when a law number is missing", () => {
    const chunks = Array.from({ length: 17 }, (_, i) => chunkFor(i + 1)).filter(
      (c) => c.lawNumber !== 9,
    );
    expect(() => assertCompleteLawSet(chunks)).toThrow(/expected law numbers 1-17, got:/);
  });

  it("throws when an out-of-range law number is present (e.g. a coincidental divider match)", () => {
    const chunks = [...Array.from({ length: 17 }, (_, i) => chunkFor(i + 1)), chunkFor(23)];
    expect(() => assertCompleteLawSet(chunks)).toThrow(/expected law numbers 1-17, got:/);
  });

  it("throws with an empty chunk list", () => {
    expect(() => assertCompleteLawSet([])).toThrow(/expected law numbers 1-17, got:/);
  });
});
