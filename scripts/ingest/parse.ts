import { extractText, getDocumentProxy } from "unpdf";

// The live PDF's running header renders as "Laws of the Game YYYY/YY" in the plain case,
// but on many pages unpdf extracts it with letter-spacing artifacts from the header's
// styled font (e.g. "L aws o f the Game 2025/26") and a page number glued directly to the
// front with no separating whitespace (e.g. "87L aws o f the Game 2025/26 | L aw 7 | The
// Duration of the Match"). This single regex tolerates the optional glued page number,
// optional internal letter-spacing, and an optional trailing "| ..." breadcrumb.
const RUNNING_HEADER = /^\d{0,4}\s*L\s*aws?\s+o\s*f\s+the\s+Game\s+\d{4}\/\d{2}\s*(\|.*)?$/i;

export function cleanText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // A bare 1-2 digit line right after a standalone "Law" line is a chapter divider's
    // number (e.g. "Law\n17"), not a page number — keep it so chunk.ts can find it.
    const isLawDividerNumber = /^\d{1,2}$/.test(t) && kept[kept.length - 1]?.trim() === "Law";
    if (/^\d{1,3}$/.test(t) && !isLawDividerNumber) continue; // bare page numbers
    if (RUNNING_HEADER.test(t)) continue; // running header (plain or PDF-mangled)
    kept.push(lines[i]);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Chapter dividers in the live PDF render as "Law" and the bare number on their own
// consecutive lines (the spelled-out title is a stylized graphic, not extractable text).
const LAW_DIVIDER = /^Law\n(\d{1,2})\s*$/gm;

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
  const dividers = [...raw.matchAll(LAW_DIVIDER)];
  if (dividers.length === 0) return raw;
  const lastDivider = dividers[dividers.length - 1];
  const searchStart = lastDivider.index! + lastDivider[0].length;
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
