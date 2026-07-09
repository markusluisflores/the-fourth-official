import { describe, expect, it } from "vitest";
import { cleanText } from "../scripts/ingest/parse";

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
});
