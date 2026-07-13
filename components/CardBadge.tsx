export function CardBadge({ kind, message }: { kind: "yellow" | "red"; message: string }) {
  return (
    <p className="flex items-center gap-2 text-sm" role="alert">
      <span
        aria-hidden
        className={`inline-block h-4 w-3 shrink-0 -rotate-6 rounded-[3px] shadow-sm ${
          kind === "yellow" ? "bg-card-yellow" : "bg-card-red"
        }`}
      />
      <span className={kind === "red" ? "text-error" : ""}>{message}</span>
    </p>
  );
}
