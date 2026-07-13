"use client";

import type { RulingSegment } from "@/lib/ask-stream";

export function flashPassage(passageNumber: number) {
  const el = document.getElementById(`passage-${passageNumber}`);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  el.classList.add("bg-accent/15");
  setTimeout(() => el.classList.remove("bg-accent/15"), 1000);
}

export function RulingCard({
  segments,
  streaming,
}: {
  segments: RulingSegment[];
  streaming: boolean;
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
              onClick={() => flashPassage(seg.passageNumber)}
              aria-label={`Show cited passage ${seg.passageNumber}`}
              className="mx-0.5 inline-block min-h-6 cursor-pointer px-1 font-mono text-sm font-medium text-accent"
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
