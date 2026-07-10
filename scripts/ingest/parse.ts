import { extractText, getDocumentProxy } from "unpdf";

// The live PDF's running header renders as "Laws of the Game YYYY/YY" in the plain case,
// but on many pages unpdf extracts it with letter-spacing artifacts from the header's
// styled font (e.g. "L aws o f the Game 2025/26") and a page number glued directly to the
// front with no separating whitespace (e.g. "87L aws o f the Game 2025/26 | L aw 7 | The
// Duration of the Match"). This single regex tolerates the optional glued page number,
// optional internal letter-spacing, and an optional trailing "| ..." breadcrumb.
const RUNNING_HEADER = /^\d{0,4}\s*L\s*aws?\s+o\s*f\s+the\s+Game\s+\d{4}\/\d{2}\s*(\|.*)?$/i;

// Chapter dividers in the live PDF render as "Law" and the bare chapter number on their
// own consecutive lines (the spelled-out title is a stylized graphic, not extractable
// text). This is the single, shared definition of "is this line pair a chapter
// divider" — used by cleanText and truncateBackMatter below, and by chunk.ts's
// splitByLaw, so the check can't silently diverge between call sites (e.g. one trimming
// whitespace and the other not). Both lines are trimmed before comparing, since the
// live PDF and hand-written test fixtures aren't guaranteed to be whitespace-clean.
export function isLawDivider(lawLine: string, numberLine: string): boolean {
  return lawLine.trim() === "Law" && /^\d{1,2}$/.test(numberLine.trim());
}

export function cleanText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // A bare 1-2 digit line right after a standalone "Law" line is a chapter divider's
    // number (e.g. "Law\n17"), not a page number — keep it so chunk.ts can find it.
    const isLawDividerNumber = isLawDivider(kept[kept.length - 1] ?? "", lines[i]);
    if (/^\d{1,3}$/.test(t) && !isLawDividerNumber) continue; // bare page numbers
    if (RUNNING_HEADER.test(t)) continue; // running header (plain or PDF-mangled)
    kept.push(lines[i]);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// After the last numbered Law's real content, the PDF continues straight into back
// matter (VAR protocol, FIFA Quality Programme, Glossary, referee terms, practical
// guidelines — roughly 40% of the document) with no numbered-law divider of its own.
// One signal is a running header that still says "Laws of the Game YYYY/YY | <title>"
// but whose title is NOT "Law N". However running headers only start appearing from a
// section's SECOND page onward, so relying on this alone catches the boundary one page
// too late — the back matter's own divider page (its first page) has no such header, so
// its opening content (e.g. the VAR protocol's numbered "Principles" list) leaks into
// the last law. See BACK_MATTER_TITLE below for the earlier, reliable signal.
const BACK_MATTER_HEADER =
  /\d{0,4}\s*L\s*aws?\s+o\s*f\s+the\s+Game\s+\d{4}\/\d{2}\s*\|(?!\s*L\s*aw\s*\d)/i;

// The back matter's own stylized divider title renders the same way "Law\nN" does — one
// word per line — as "Video\nassistant\nreferee (VAR)\nprotocol". This is the earliest
// reliable truncation signal, appearing on the back matter's very first page, before any
// running header. Specific to this PDF release (CORPUS_VERSION = "2025-26"); a future
// edition's layout may need a different literal marker.
const BACK_MATTER_TITLE = "Video\nassistant\nreferee (VAR)\nprotocol";

export function truncateBackMatter(raw: string): string {
  // Find the char offset right after the last "Law\nN" divider's number line, via the
  // same isLawDivider predicate splitByLaw uses in chunk.ts — a line-by-line scan
  // rather than a regex, so there's exactly one definition of "divider" for both.
  const lines = raw.split("\n");
  let lastDividerEnd: number | null = null;
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const numberLine = lines[i + 1];
    if (numberLine !== undefined && isLawDivider(lines[i], numberLine)) {
      lastDividerEnd = lineStart + lines[i].length + 1 + numberLine.length;
    }
    lineStart += lines[i].length + 1;
  }
  if (lastDividerEnd === null) return raw;
  const searchStart = lastDividerEnd;
  const tail = raw.slice(searchStart);

  const headerMatch = tail.match(BACK_MATTER_HEADER);
  const titleIndex = tail.indexOf(BACK_MATTER_TITLE);

  const candidates = [
    headerMatch ? headerMatch.index! : Infinity,
    titleIndex >= 0 ? titleIndex : Infinity,
  ];
  const cutIndex = Math.min(...candidates);
  if (cutIndex === Infinity) return raw;
  return raw.slice(0, searchStart + cutIndex);
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  // mergePages:true drops every newline, which breaks every line-based regex below —
  // extract per page (each page's internal line breaks are preserved) and rejoin.
  const { text: pages } = await extractText(pdf, { mergePages: false });
  const raw = pages.join("\n");
  return cleanText(truncateBackMatter(raw));
}
