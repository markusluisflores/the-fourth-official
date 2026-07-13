import { RELEVANCE_THRESHOLD } from "@/lib/glass-constants";
import type { GlassChunk } from "@/lib/ask-stream";

export function GlassBox({
  chunks,
  citedDocumentIndexes,
  maxSimilarity,
  open,
  onToggle,
}: {
  chunks: GlassChunk[];
  citedDocumentIndexes: number[];
  maxSimilarity: number | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  if (chunks.length === 0) return null;
  const best = maxSimilarity ?? Math.max(...chunks.map((c) => c.similarity));
  return (
    <details
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
      className="border-t border-foreground/15 pt-3"
    >
      <summary className="min-h-11 cursor-pointer list-none text-sm font-medium">
        <span aria-hidden>{open ? "▾" : "▸"}</span> How this answer was built · {chunks.length}{" "}
        passages retrieved
      </summary>
      <table className="mt-2 w-full text-left font-mono text-xs">
        <thead>
          <tr className="opacity-60">
            <th className="py-1 pr-2 font-normal">#</th>
            <th className="py-1 pr-2 font-normal">passage</th>
            <th className="py-1 pr-2 font-normal">similarity</th>
            <th className="py-1 font-normal">cited</th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((c, i) => (
            <tr key={c.id} className="border-t border-foreground/10">
              <td className="py-1.5 pr-2">{i + 1}</td>
              <td className="py-1.5 pr-2">{c.breadcrumb}</td>
              <td className="py-1.5 pr-2">{c.similarity.toFixed(3)}</td>
              <td className="py-1.5">{citedDocumentIndexes.includes(i) ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 font-mono text-xs opacity-60">
        gate: max similarity {best.toFixed(3)} {best >= RELEVANCE_THRESHOLD ? "≥" : "<"} threshold{" "}
        {RELEVANCE_THRESHOLD}
      </p>
    </details>
  );
}
