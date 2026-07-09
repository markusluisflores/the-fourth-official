export interface RawChunk {
  lawNumber: number;
  breadcrumb: string;
  content: string;
}

export const MAX_CHUNK_CHARS = 1500;

const LAW_HEADING = /^LAW\s+(\d{1,2})\s+([A-Z][A-Z ,'&-]*)$/m;
const SECTION_HEADING = /^(\d{1,2})\.\s+(\S.*)$/;

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

  for (const line of lines) {
    const m = line.match(LAW_HEADING);
    if (m) {
      if (current) parts.push({ lawNumber: current.lawNumber, body: current.bodyLines.join("\n") });
      current = { lawNumber: Number(m[1]), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
    // lines before the first LAW heading (front matter) are dropped in v1
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
  const pieces: string[] = [];
  let buffer = "";
  for (const para of body.split(/\n\n+/)) {
    if (buffer && buffer.length + para.length + 2 > MAX_CHUNK_CHARS) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += (buffer ? "\n\n" : "") + para;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}
