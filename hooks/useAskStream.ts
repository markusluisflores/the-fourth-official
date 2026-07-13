"use client";

import { useCallback, useReducer, useRef } from "react";
import { askReducer, initialAskState, type AskAction, type AskState } from "@/lib/ask-stream";
import { createSseParser } from "@/lib/sse-client";

const NETWORK_ERROR = "something went wrong, please try again shortly";

export function useAskStream(): { state: AskState; ask: (question: string) => Promise<void> } {
  const [state, dispatch] = useReducer(askReducer, initialAskState);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "submit", question });

    let res: Response;
    try {
      res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "request_failed", message: NETWORK_ERROR });
      return;
    }

    if (res.status === 401) {
      window.location.href = "/gate";
      return;
    }

    if (res.headers.get("content-type")?.includes("application/json")) {
      const body = await res.json();
      if (body.kind === "gated") {
        dispatch({
          type: "gated",
          message: body.message,
          chunks: body.chunks,
          maxSimilarity: body.maxSimilarity,
          remaining: body.remaining,
        });
      } else if (body.kind === "rate_limited") {
        dispatch({ type: "rate_limited", scope: body.scope, message: body.message });
      } else {
        dispatch({ type: "request_failed", message: body.error ?? NETWORK_ERROR });
      }
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const feed = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of feed(decoder.decode(value, { stream: true }))) {
          dispatch(sseToAction(ev.event, ev.data));
        }
      }
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "stream_error", message: NETWORK_ERROR });
    }
  }, []);

  return { state, ask };
}

function sseToAction(event: string, data: unknown): AskAction {
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
