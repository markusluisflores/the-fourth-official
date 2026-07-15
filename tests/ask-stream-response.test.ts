import { describe, expect, it } from "vitest";
import { classifyAskResponse, NETWORK_ERROR } from "../lib/ask-stream-response";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("classifyAskResponse", () => {
  it("redirects on 401", async () => {
    const res = new Response(null, { status: 401 });
    expect(await classifyAskResponse(res)).toEqual({ kind: "redirect" });
  });

  it("maps a gated JSON body to a gated action", async () => {
    const res = jsonRes({
      kind: "gated",
      message: "off-topic",
      chunks: [],
      maxSimilarity: 0.1,
      remaining: { visitor: 5 },
    });
    expect(await classifyAskResponse(res)).toEqual({
      kind: "action",
      action: {
        type: "gated",
        message: "off-topic",
        chunks: [],
        maxSimilarity: 0.1,
        remaining: { visitor: 5 },
      },
    });
  });

  it("maps a rate_limited JSON body to a rate_limited action", async () => {
    const res = jsonRes({ kind: "rate_limited", scope: "global", message: "come back tomorrow" });
    expect(await classifyAskResponse(res)).toEqual({
      kind: "action",
      action: { type: "rate_limited", scope: "global", message: "come back tomorrow" },
    });
  });

  it("maps a generic error JSON body to request_failed using body.error", async () => {
    const res = jsonRes({ error: "bad request" }, 400);
    expect(await classifyAskResponse(res)).toEqual({
      kind: "action",
      action: { type: "request_failed", message: "bad request" },
    });
  });

  it("falls back to NETWORK_ERROR when an error JSON body has no error field", async () => {
    const res = jsonRes({}, 500);
    expect(await classifyAskResponse(res)).toEqual({
      kind: "action",
      action: { type: "request_failed", message: NETWORK_ERROR },
    });
  });

  it("dispatches request_failed for a non-OK, non-JSON response (#30)", async () => {
    const res = new Response("<html><body>500 Internal Server Error</body></html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    expect(await classifyAskResponse(res)).toEqual({
      kind: "action",
      action: { type: "request_failed", message: NETWORK_ERROR },
    });
  });

  it("treats an OK, non-JSON response as an SSE stream", async () => {
    const res = new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(await classifyAskResponse(res)).toEqual({ kind: "stream" });
  });
});
