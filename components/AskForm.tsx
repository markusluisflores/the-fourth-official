"use client";

import { useState } from "react";
import { MAX_QUESTION_CHARS } from "@/lib/constants";

export function AskForm({
  busy,
  disabled,
  onAsk,
}: {
  busy: boolean;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (question.trim()) onAsk(question);
      }}
      className="flex flex-col gap-1"
    >
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={MAX_QUESTION_CHARS}
          placeholder="Ask about the Laws of the Game"
          aria-label="Your question"
          disabled={disabled}
          className="min-h-11 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || disabled || question.trim().length === 0}
          className="min-h-11 rounded-md bg-accent px-6 font-semibold text-accent-contrast disabled:opacity-50"
        >
          {busy ? "…" : "Ask"}
        </button>
      </div>
      <span className="self-end font-mono text-xs opacity-50">
        {question.length}/{MAX_QUESTION_CHARS}
      </span>
    </form>
  );
}
