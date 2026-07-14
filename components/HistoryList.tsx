"use client";

import { useState } from "react";
import { historyEntryMessage, REFUSED_MESSAGE, type AskState } from "@/lib/ask-stream";
import { CardBadge } from "@/components/CardBadge";
import { RulingCard } from "@/components/RulingCard";
import { LawPassages } from "@/components/LawPassages";

export interface HistoryEntry {
  question: string;
  state: AskState;
}

export function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (entries.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">
        Earlier this visit
      </h2>
      <ul className="mt-2 flex flex-col gap-1 border-t border-foreground/15 pt-3">
        {entries.map((entry, i) => (
          <li key={i}>
            <button
              onClick={() => setOpenIndex(openIndex === i ? null : i)}
              className="min-h-11 w-full cursor-pointer text-left text-sm opacity-80 hover:opacity-100"
            >
              <span aria-hidden>{openIndex === i ? "▾" : "▸"}</span> {entry.question}
            </button>
            {openIndex === i && (
              <div className="mb-3 flex flex-col gap-4 pl-4">
                {entry.state.phase === "refused" && (
                  <CardBadge kind="red" message={REFUSED_MESSAGE} />
                )}
                {entry.state.phase === "gated" && (
                  <p className="text-sm">{historyEntryMessage(entry.state)}</p>
                )}
                <RulingCard
                  segments={entry.state.segments}
                  streaming={false}
                  instanceId={`history-${i}`}
                />
                <LawPassages passages={entry.state.passages} instanceId={`history-${i}`} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
