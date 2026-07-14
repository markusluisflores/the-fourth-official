"use client";

import type { RulingSegment } from "@/lib/ask-stream";

export function flashPassage(instanceId: string, passageNumber: number) {
  const el = document.getElementById(`passage-${instanceId}-${passageNumber}`);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  el.classList.add("bg-accent/15");
  setTimeout(() => el.classList.remove("bg-accent/15"), 1000);
}

export function RulingCard({
  segments,
  streaming,
  instanceId,
}: {
  segments: RulingSegment[];
  streaming: boolean;
  // Scopes flashPassage's lookup to this instance's own LawPassages list —
  // see the matching comment in LawPassages.tsx.
  instanceId: string;
}) {
  if (segments.length === 0 && !streaming) return null;
  return (
    <section aria-live="polite">
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">The ruling</h2>
      <p className="mt-2 border-t border-foreground/15 pt-3 text-base leading-7">
        {segments.map((seg, i) =>
          seg.type === "text" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <button
              key={i}
              onClick={() => flashPassage(instanceId, seg.passageNumber)}
              aria-label={`Show cited passage ${seg.passageNumber}`}
              className="mx-0.5 inline-block min-h-11 cursor-pointer px-1 font-mono text-sm font-medium text-accent"
            >
              [{seg.passageNumber}]
            </button>
          ),
        )}
        {streaming && (
          <span
            className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle"
            aria-hidden
          />
        )}
      </p>
    </section>
  );
}
