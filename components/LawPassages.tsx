import type { CitedPassage } from "@/lib/ask-stream";

export function LawPassages({ passages }: { passages: CitedPassage[] }) {
  if (passages.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">
        What the law says
      </h2>
      <ul className="mt-2 flex flex-col gap-3 border-t border-foreground/15 pt-3">
        {passages.map((p) => (
          <li
            key={p.passageNumber}
            id={`passage-${p.passageNumber}`}
            className="rounded transition-colors duration-300"
          >
            <span className="font-mono text-sm text-accent">[{p.passageNumber}]</span>{" "}
            <span className="font-mono text-sm">{p.breadcrumb}</span>
            <blockquote className="mt-1 border-l-2 border-foreground/20 pl-3 text-sm italic opacity-90 whitespace-pre-line">
              “{p.citedText}”
            </blockquote>
          </li>
        ))}
      </ul>
    </section>
  );
}
