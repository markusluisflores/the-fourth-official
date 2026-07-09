import { isLawDivider } from "./parse";

export interface RawChunk {
  lawNumber: number;
  breadcrumb: string;
  content: string;
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
