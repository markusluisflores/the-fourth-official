"use client";

import { useEffect, useRef, useState } from "react";
import { AskForm } from "@/components/AskForm";
import { CardBadge } from "@/components/CardBadge";
import { GlassBox } from "@/components/GlassBox";
import { HistoryList, type HistoryEntry } from "@/components/HistoryList";
import { LawPassages } from "@/components/LawPassages";
import { RemainingBadge } from "@/components/RemainingBadge";
import { RulingCard } from "@/components/RulingCard";
import { useAskStream } from "@/hooks/useAskStream";

const TERMINAL = ["completed", "refused", "failed", "failed_partial", "gated"] as const;

export default function AskPage() {
  const { state, ask } = useAskStream();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Q4: glass box opens on the first answer of the visit; after the user
  // touches the toggle, their preference wins for the rest of the visit.
  const [glassOpen, setGlassOpen] = useState(true);
  const userToggled = useRef(false);
  const lastArchived = useRef<string | null>(null);

  const busy = state.phase === "submitting" || state.phase === "streaming";
  const isTerminal = (TERMINAL as readonly string[]).includes(state.phase);

  // Q2: archive each finished Q&A into the visit history exactly once.
  useEffect(() => {
    if (!isTerminal) return;
    if (state.segments.length + state.chunks.length === 0) return;
    if (lastArchived.current === state.question) return;
    lastArchived.current = state.question;
    setHistory((h) => [{ question: state.question, state }, ...h]);
  }, [isTerminal, state]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">The Fourth Official</h1>
          <p className="font-mono text-xs opacity-60">Laws of the Game 2025/26</p>
        </div>
        <RemainingBadge remaining={state.remaining} />
      </header>

      <AskForm
        busy={busy}
        disabled={state.phase === "limited" && state.limitScope === "global"}
        onAsk={ask}
      />

      {state.phase === "limited" && <CardBadge kind="yellow" message={state.message ?? ""} />}
      {state.phase === "failed" && <CardBadge kind="red" message={state.message ?? ""} />}
      {state.phase === "refused" && (
        <CardBadge kind="red" message="The Fourth Official declined to answer that one." />
      )}
      {state.phase === "gated" && <p className="text-sm">{state.message}</p>}

      <RulingCard segments={state.segments} streaming={state.phase === "streaming"} />
      {state.phase === "failed_partial" && (
        <CardBadge kind="red" message={`answer incomplete — ${state.message ?? ""}`} />
      )}
      <LawPassages passages={state.passages} />
      <GlassBox
        chunks={state.chunks}
        citedDocumentIndexes={state.citedDocumentIndexes}
        maxSimilarity={state.maxSimilarity}
        open={glassOpen}
        onToggle={(open) => {
          userToggled.current = true;
          setGlassOpen(open);
        }}
      />

      <HistoryList entries={history} />
    </main>
  );
}
