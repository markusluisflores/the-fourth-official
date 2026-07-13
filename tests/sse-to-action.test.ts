import { describe, expect, it } from "vitest";
import { sseToAction } from "../lib/sse-to-action";

describe("sseToAction", () => {
  it("maps meta to a meta action", () => {
    expect(sseToAction("meta", { chunks: [{ id: 1 }], remaining: { visitor: 19 } })).toEqual({
      type: "meta",
      chunks: [{ id: 1 }],
      remaining: { visitor: 19 },
    });
  });

  it("maps text to a text action", () => {
    expect(sseToAction("text", { delta: "No " })).toEqual({ type: "text", delta: "No " });
  });

  it("maps citation to a citation action", () => {
    expect(
      sseToAction("citation", { documentIndex: 0, citedText: "the ball is out of play" }),
    ).toEqual({
      type: "citation",
      documentIndex: 0,
      citedText: "the ball is out of play",
    });
  });

  it("maps done to a done action", () => {
    expect(sseToAction("done", { citedDocumentIndexes: [0, 1] })).toEqual({
      type: "done",
      citedDocumentIndexes: [0, 1],
    });
  });

  it("maps refusal to a refusal action", () => {
    expect(sseToAction("refusal", {})).toEqual({ type: "refusal" });
  });

  it("maps error to a stream_error action", () => {
    expect(sseToAction("error", { message: "upstream timeout" })).toEqual({
      type: "stream_error",
      message: "upstream timeout",
    });
  });

  it("falls back to a stream_error action for an unknown event", () => {
    expect(sseToAction("ping", {})).toEqual({
      type: "stream_error",
      message: "unknown event: ping",
    });
  });
});
