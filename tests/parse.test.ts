import { describe, expect, it } from "vitest";
import { cleanText, truncateBackMatter } from "../scripts/ingest/parse";

describe("cleanText", () => {
  it("drops standalone page-number lines", () => {
    expect(cleanText("Some rule text\n87\nMore text")).toBe("Some rule text\nMore text");
  });

  it("drops running-header lines", () => {
    expect(cleanText("Laws of the Game 2025/26\nReal content")).toBe("Real content");
  });

  it("collapses 3+ newlines to a double newline", () => {
    expect(cleanText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("normalizes windows line endings", () => {
    expect(cleanText("a\r\nb")).toBe("a\nb");
  });

  // The real PDF (extracted via unpdf) renders running headers with letter-spacing
  // artifacts and a page number glued directly to the front, e.g. on Law 7's first page:
  // "87L aws o f the Game 2025/26 | L aw 7 | The Duration of the Match". The synthetic
  // fixture above ("Laws of the Game 2025/26") never exercised this — found running
  // `npm run ingest` against data/laws-2025-26.pdf.
  it("drops running-header lines with live-PDF letter-spacing and a glued page number", () => {
    const raw =
      "Some rule text\n87L aws o f the Game 2025/26 | L aw 7 | The Duration of the Match\nMore text";
    expect(cleanText(raw)).toBe("Some rule text\nMore text");
  });

  it("drops running-header lines for non-Law back-matter sections (no glued page number)", () => {
    const raw = "Some rule text\nL aws o f the Game 2025/26 | VAR protocol\nMore text";
    expect(cleanText(raw)).toBe("Some rule text\nMore text");
  });

  // The bare-page-number filter above is indiscriminate: a Law divider's number line
  // ("Law\n17") is itself a bare 1-2 digit line and was being silently stripped, which
  // deleted every Law divider from the cleaned text and made chunkRulebook produce 0
  // chunks against the real PDF. A number line immediately after a standalone "Law"
  // line must be kept.
  it("keeps a bare number line that immediately follows a standalone 'Law' line", () => {
    const raw = "Some rule text\nLaw\n17\n1. Procedure\nCorner kick rules.";
    expect(cleanText(raw)).toBe("Some rule text\nLaw\n17\n1. Procedure\nCorner kick rules.");
  });

  it("still drops a bare page-number line that does not follow 'Law'", () => {
    const raw = "Some rule text\n87\nMore text\nLaw\n17\nSection text.";
    expect(cleanText(raw)).toBe("Some rule text\nMore text\nLaw\n17\nSection text.");
  });
});

describe("truncateBackMatter", () => {
  // The real PDF has no numbered-law divider between Law 17 and the trailing back
  // matter (VAR protocol, FIFA Quality Programme, Glossary, referee terms, practical
  // guidelines — roughly 40% of the document by line count). Without truncation, all
  // of it silently gets absorbed into law_number=17.
  it("drops content after the last numbered Law once a non-Law running header appears", () => {
    const raw = [
      "Law",
      "17",
      "143L aws o f the Game 2025/26 | L aw 17 | The Corner Kick",
      "1. Procedure",
      "Corner kick rules.",
      "L aws o f the Game 2025/26 | VAR protocol",
      "VAR protocol content that should not appear in law 17.",
    ].join("\n");
    const truncated = truncateBackMatter(raw);
    expect(truncated).toContain("Corner kick rules.");
    expect(truncated).not.toContain("VAR protocol content");
  });

  it("returns the text unchanged when no back-matter header is found", () => {
    const raw = "Law\n1\nSome content with no trailing back matter.";
    expect(truncateBackMatter(raw)).toBe(raw);
  });

  it("returns the text unchanged when there is no Law divider at all", () => {
    const raw = "Just some front matter with no Law headings.";
    expect(truncateBackMatter(raw)).toBe(raw);
  });

  // Real gap: the back matter's own divider page has no running header (running headers
  // only start appearing from a section's SECOND page onward), so the BACK_MATTER_HEADER
  // regex alone caught the VAR protocol content one page too late — "1. Principles" and
  // its numbered sub-points ("1. A video assistant referee...", "2. The referee must
  // always...") leaked into law_number=17 as spurious sections. Found by inspecting the
  // real chunkRulebook() output against data/laws-2025-26.pdf (Law 17 had 7 chunks
  // instead of the expected 3). The back matter's own stylized divider title —
  // "Video\nassistant\nreferee (VAR)\nprotocol", one word per line like "Law\nN" — is the
  // earliest reliable signal.
  it("drops back matter starting at its own stylized divider title, even before any running header appears", () => {
    const raw = [
      "Law",
      "17",
      "143L aws o f the Game 2025/26 | L aw 17 | The Corner Kick",
      "2. Offences and sanctions",
      "For any other offence, the kick is retaken.",
      "145",
      "Video",
      "assistant",
      "referee (VAR)",
      "protocol",
      "147",
      "The VAR protocol, as far as possible, conforms to the principles.",
      "1. Principles",
      "1. A video assistant referee (VAR) is a match official.",
    ].join("\n");
    const truncated = truncateBackMatter(raw);
    expect(truncated).toContain("For any other offence, the kick is retaken.");
    expect(truncated).not.toContain("1. Principles");
    expect(truncated).not.toContain("video assistant referee (VAR) is a match official");
  });
});
