// Client-side mirror of RELEVANCE_THRESHOLD in lib/retrieval.ts (server-only
// module — not importable from client components). Keep in sync; the eval
// harness calibrates the server value (see retrieval.ts's comment).
export const RELEVANCE_THRESHOLD = 0.35;

// Client-side mirror of VISITOR_DAILY_LIMIT in lib/rate-limit.ts (also
// server-only). Keep in sync — a test in tests/retrieval.test.ts pins both
// mirrors in this file against their server-side originals.
export const VISITOR_DAILY_LIMIT = 20;
