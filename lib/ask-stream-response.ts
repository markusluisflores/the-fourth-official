// Classifies a POST /api/ask fetch Response into what useAskStream should do
// next. Pure given a Response (only res.json() has a side effect, and that's
// unavoidable — reading the body). No React, no dispatch — fully
// unit-testable per the same lib/-with-tests pattern as askReducer.
import type { AskAction } from "./ask-stream";

export const NETWORK_ERROR = "something went wrong, please try again shortly";

export type AskResponseOutcome =
  { kind: "redirect" } | { kind: "action"; action: AskAction } | { kind: "stream" };

export async function classifyAskResponse(res: Response): Promise<AskResponseOutcome> {
  if (res.status === 401) return { kind: "redirect" };

  if (res.headers.get("content-type")?.includes("application/json")) {
    const body = await res.json();
    if (body.kind === "gated") {
      return {
        kind: "action",
        action: {
          type: "gated",
          message: body.message,
          chunks: body.chunks,
          maxSimilarity: body.maxSimilarity,
          remaining: body.remaining,
        },
      };
    }
    if (body.kind === "rate_limited") {
      return {
        kind: "action",
        action: { type: "rate_limited", scope: body.scope, message: body.message },
      };
    }
    return {
      kind: "action",
      action: { type: "request_failed", message: body.error ?? NETWORK_ERROR },
    };
  }

  // A non-OK response that isn't JSON (e.g. a platform-level HTML 500) isn't
  // an SSE stream either — dispatch request_failed instead of handing it to
  // the SSE reader, which would parse zero events and never dispatch (#30).
  if (!res.ok) {
    return { kind: "action", action: { type: "request_failed", message: NETWORK_ERROR } };
  }

  return { kind: "stream" };
}
