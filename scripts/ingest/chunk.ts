import { isLawDivider } from "./parse";

export interface RawChunk {
  lawNumber: number;
  breadcrumb: string;
  content: string;
  embeddingText?: string;
}

export const MAX_CHUNK_CHARS = 1500;

// Chapter dividers in the live PDF (extracted via unpdf) render as "Law" and the bare
// chapter number on their own consecutive lines — the spelled-out title is a stylized
// graphic and isn't extractable as plain text, unlike the synthetic "LAW 11 OFFSIDE"
// single-line fixture this regex originally targeted. See parse.ts's isLawDivider for
// the shared divider-detection predicate, also used by truncateBackMatter's boundary
// logic.
const SECTION_HEADING = /^(\d{1,2})\.\s+(\S.*)$/;

export const EXPECTED_LAW_NUMBERS = Array.from({ length: 17 }, (_, i) => i + 1);

// The divider-detection regexes above have no semantic guard: any "Law" line
// immediately followed by a bare 1-2 digit line (a stray table-of-contents entry, an
// index reference, a coincidental caption) is treated as a real chapter divider with no
// range or ordering check. This is the backstop — after chunking, assert the set of
// distinct law numbers actually present is exactly {1..17}, no more, no fewer, so a
// corrupted parse fails loudly instead of silently ingesting bad data.
export function assertCompleteLawSet(chunks: RawChunk[]): void {
  const lawNumbers = [...new Set(chunks.map((c) => c.lawNumber))].sort((a, b) => a - b);
  const isComplete =
    lawNumbers.length === EXPECTED_LAW_NUMBERS.length &&
    lawNumbers.every((n, i) => n === EXPECTED_LAW_NUMBERS[i]);
  if (!isComplete) {
    throw new Error(`expected law numbers 1-17, got: ${lawNumbers.join(", ")}`);
  }
}

export function chunkRulebook(text: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const lawParts = splitByLaw(text);

  for (const { lawNumber, body } of lawParts) {
    for (const section of splitBySection(body)) {
      const crumb = `Law ${lawNumber} › ${section.title}`;
      for (const piece of splitOversize(section.body)) {
        chunks.push({ lawNumber, breadcrumb: crumb, content: piece });
      }
    }
  }
  return chunks;
}

function splitByLaw(text: string): { lawNumber: number; body: string }[] {
  const parts: { lawNumber: number; body: string }[] = [];
  const lines = text.split("\n");
  let current: { lawNumber: number; bodyLines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rawNextLine = lines[i + 1] ?? "";
    const isDivider = isLawDivider(line, rawNextLine);
    if (isDivider) {
      if (current) parts.push({ lawNumber: current.lawNumber, body: current.bodyLines.join("\n") });
      current = { lawNumber: Number(rawNextLine.trim()), bodyLines: [] };
      i++; // consume the number line too — it's part of the divider, not body content
    } else if (current) {
      current.bodyLines.push(line);
    }
    // lines before the first Law divider (front matter) are dropped in v1
  }
  if (current) parts.push({ lawNumber: current.lawNumber, body: current.bodyLines.join("\n") });
  return parts;
}

function splitBySection(body: string): { title: string; body: string }[] {
  const sections: { title: string; bodyLines: string[] }[] = [];
  let current = { title: "Introduction", bodyLines: [] as string[] };

  for (const line of body.split("\n")) {
    const m = line.trim().match(SECTION_HEADING);
    if (m) {
      if (current.bodyLines.some((l) => l.trim() !== "")) sections.push(current);
      current = { title: `${m[1]}. ${m[2].trim()}`, bodyLines: [] };
    } else {
      current.bodyLines.push(line);
    }
  }
  if (current.bodyLines.some((l) => l.trim() !== "")) sections.push(current);

  return sections.map((s) => ({ title: s.title, body: s.bodyLines.join("\n").trim() }));
}

function splitOversize(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  // The live PDF's extracted text has no blank-line paragraph breaks — every
  // "paragraph" is a run of single-newline-separated wrapped lines. Prefer splitting on
  // "\n\n" (real paragraph breaks, when present) but fall back to single lines when the
  // body doesn't have any, so an oversized section is still broken up instead of passing
  // through as one unsplittable piece.
  const paragraphs = body.split(/\n\n+/);
  const [units, glue] = paragraphs.length > 1 ? [paragraphs, "\n\n"] : [body.split("\n"), "\n"];
  return packUnits(units, glue);
}

function packUnits(units: string[], glue: string): string[] {
  const pieces: string[] = [];
  let buffer = "";
  for (const unit of units) {
    if (buffer && buffer.length + unit.length + glue.length > MAX_CHUNK_CHARS) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    if (!buffer && unit.length > MAX_CHUNK_CHARS) {
      // a single unit is still oversized on its own (e.g. one very long line) — hard-wrap
      // it at MAX_CHUNK_CHARS as a last resort so every piece stays within the limit.
      for (let i = 0; i < unit.length; i += MAX_CHUNK_CHARS) {
        pieces.push(unit.slice(i, i + MAX_CHUNK_CHARS).trim());
      }
      continue;
    }
    buffer += (buffer ? glue : "") + unit;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}

// Breadcrumb-keyed overrides: enriched text fed to the embedding step instead of the
// chunk's real content, so its search fingerprint can be nudged closer to phrasings the
// bare rulebook text doesn't share vocabulary with. The chunk's displayed content is
// never touched — only what gets embedded changes. Each entry must be the FULL
// replacement text (original content + addition), not a suffix to concatenate, so
// there's no string-building logic to get wrong. See
// docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md for why each
// entry exists and how its wording was chosen.
export const EMBEDDING_TEXT_OVERRIDES: Record<string, string> = {
  "Law 3 › 1. Number of players":
    "A match is played by two teams, each with a maximum of eleven players;\n" +
    "one must be the goalkeeper. A match may not start or continue if either team\n" +
    "has fewer than seven players.\n" +
    "If a team has fewer than seven players because one or more players has\n" +
    "deliberately left the field of play, the referee is not obliged to stop play and\n" +
    "the advantage may be played, but the match must not resume after the ball has\n" +
    "gone out of play if a team does not have the minimum number of seven players.\n" +
    "If the competition rules state that all players and substitutes must be named\n" +
    "before kick-off and a team starts a match with fewer than eleven players,\n" +
    "only the players and substitutes named on the team list may take part in the\n" +
    "match upon their arrival.\n" +
    "This rule applies regardless of the reason a team has fewer than seven players, " +
    "including when players are sent off — for example after receiving a red card — " +
    "and the team's number of players falls below the seven-player minimum.",
};

// Applies EMBEDDING_TEXT_OVERRIDES to a chunk list, setting embeddingText on the one
// matching chunk per breadcrumb key. Called from index.ts's main() after
// chunkRulebook() produces the full corpus — NOT called from inside chunkRulebook
// itself, so chunkRulebook's own unit tests are unaffected: this function is never
// invoked by chunkRulebook or by chunkRulebook's tests (one of those tests does use the
// real "Law 3 › 1. Number of players" breadcrumb in its fixture, but that's irrelevant
// here — this function simply never runs during that test). Fails loudly (never
// silently) on a breadcrumb that matches
// zero or more than one chunk (breadcrumbs are not guaranteed unique — see
// splitOversize, which already produces multiple chunks sharing one breadcrumb for
// oversized sections), and on an override value that doesn't start with the chunk's
// real content (guards against a hand-copy slip when the override was written, or
// future corpus drift if the source PDF is ever replaced with a newer edition).
export function applyEmbeddingTextOverrides(
  chunks: RawChunk[],
  overrides: Record<string, string> = EMBEDDING_TEXT_OVERRIDES,
): RawChunk[] {
  for (const [breadcrumb, embeddingText] of Object.entries(overrides)) {
    const matches = chunks.filter((c) => c.breadcrumb === breadcrumb);
    if (matches.length !== 1) {
      throw new Error(
        `embedding-text override for "${breadcrumb}" matched ${matches.length} chunks, expected exactly 1`,
      );
    }
    if (!embeddingText.startsWith(matches[0].content)) {
      throw new Error(
        `embedding-text override for "${breadcrumb}" does not start with the chunk's real content`,
      );
    }
  }
  return chunks.map((c) =>
    c.breadcrumb in overrides ? { ...c, embeddingText: overrides[c.breadcrumb] } : c,
  );
}
