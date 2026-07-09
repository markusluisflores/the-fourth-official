import { extractText, getDocumentProxy } from "unpdf";

export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^\d{1,3}$/.test(t)) return false; // bare page numbers
      if (/^Laws of the Game \d{4}\/\d{2}/i.test(t)) return false; // running header
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return cleanText(text);
}
