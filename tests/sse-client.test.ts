import { describe, expect, it } from "vitest";
import { createSseParser } from "../lib/sse-client";

describe("createSseParser", () => {
  it("parses a complete event block", () => {
    const feed = createSseParser();
    expect(feed('event: text\ndata: {"delta":"Hi"}\n\n')).toEqual([
      { event: "text", data: { delta: "Hi" } },
    ]);
  });

  it("buffers partial chunks split mid-line and mid-block", () => {
    const feed = createSseParser();
    expect(feed("event: te")).toEqual([]);
    expect(feed('xt\ndata: {"del')).toEqual([]);
    expect(feed('ta":"Hi"}\n\n')).toEqual([{ event: "text", data: { delta: "Hi" } }]);
  });

  it("returns multiple events from one chunk in order", () => {
    const feed = createSseParser();
    const chunk =
      'event: text\ndata: {"delta":"a"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n';
    expect(feed(chunk).map((e) => e.event)).toEqual(["text", "done"]);
  });

  it("ignores blocks without data", () => {
    const feed = createSseParser();
    expect(feed("event: ping\n\n")).toEqual([]);
  });
});
