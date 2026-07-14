// Maps a decoded SSE event (as produced by lib/sse-client's parser) to the
// AskAction the reducer expects. Pure and unit-testable — no React, no
// network — per the same lib/-with-tests pattern as askReducer and
// createSseParser.
import type { AskAction } from "./ask-stream";

export function sseToAction(event: string, data: unknown): AskAction {
  const d = data as Record<string, never>;
  switch (event) {
    case "meta":
      return { type: "meta", chunks: d["chunks"], remaining: d["remaining"] };
    case "text":
      return { type: "text", delta: d["delta"] };
    case "citation":
      return { type: "citation", documentIndex: d["documentIndex"], citedText: d["citedText"] };
    case "done":
      return { type: "done", citedDocumentIndexes: d["citedDocumentIndexes"] };
    case "refusal":
      return { type: "refusal" };
    case "error":
      return { type: "stream_error", message: d["message"] };
    default:
      return { type: "stream_error", message: `unknown event: ${event}` };
  }
}
