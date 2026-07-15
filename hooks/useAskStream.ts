"use client";

import { useCallback, useReducer, useRef } from "react";
import { askReducer, initialAskState, type AskState } from "@/lib/ask-stream";
import { classifyAskResponse, NETWORK_ERROR } from "@/lib/ask-stream-response";
import { createSseParser } from "@/lib/sse-client";
import { sseToAction } from "@/lib/sse-to-action";

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

    const outcome = await classifyAskResponse(res);
    if (outcome.kind === "redirect") {
      window.location.href = "/gate";
      return;
    }
    if (outcome.kind === "action") {
      dispatch(outcome.action);
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
