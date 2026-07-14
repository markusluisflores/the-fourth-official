import { VISITOR_DAILY_LIMIT } from "@/lib/glass-constants";

export function RemainingBadge({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  return (
    <span
      className="font-mono text-xs opacity-70"
      aria-label={`${remaining} of ${VISITOR_DAILY_LIMIT} questions left today`}
    >
      {remaining} left today
    </span>
  );
}
