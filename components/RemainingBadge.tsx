export function RemainingBadge({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  return (
    <span
      className="font-mono text-xs opacity-70"
      aria-label={`${remaining} of 20 questions left today`}
    >
      {remaining}/20 today
    </span>
  );
}
