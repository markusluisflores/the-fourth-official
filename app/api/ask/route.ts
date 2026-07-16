import { NextRequest, NextResponse } from "next/server";
import { streamAnswer } from "@/lib/answer";
import { MAX_QUESTION_CHARS } from "@/lib/constants";
import {
  GLOBAL_DAILY_LIMIT,
  recordQuestion,
  trustedClientIp,
  VISITOR_DAILY_LIMIT,
  visitorKey,
} from "@/lib/rate-limit";
import { decompose, DECOMPOSE_SOFT_DEADLINE_MS } from "@/lib/decompose";
import { isRelevant, mergeResults, searchChunks, searchChunksBatch } from "@/lib/retrieval";
import { SESSION_COOKIE, verifySessionToken, VISITOR_COOKIE } from "@/lib/session";
import { serverSupabase } from "@/lib/supabase";

const GATED_MESSAGE = "I can only answer questions about the Laws of the Game.";
const UPSTREAM_ERROR = "something went wrong, please try again shortly";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Defense in depth: the middleware already gates /api/ask, but a matcher
  // typo or config drift must not silently expose the paid path. Same
  // fail-closed requireEnv() pattern as middleware.ts and
  // app/api/session/route.ts, rather than a non-null assertion, so a
  // missing SESSION_SECRET throws instead of silently verifying against
  // the literal string "undefined".
  const sessionOk = await verifySessionToken(
    requireEnv("SESSION_SECRET"),
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!sessionOk) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let question: unknown;
  try {
    ({ question } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (
    typeof question !== "string" ||
    question.trim().length === 0 ||
    question.length > MAX_QUESTION_CHARS
  ) {
    return NextResponse.json(
      { error: `question must be 1-${MAX_QUESTION_CHARS} characters` },
      { status: 400 },
    );
  }

  // Count before any paid call. A gated or failed question still consumes one —
  // simplest honest semantics, and it prevents free probing of the gate.
  //
  // Rate-limit key: platform-verified client IP (see trustedClientIp) plus
  // the visitor cookie. Task 10 probe (2026-07) confirmed Railway's edge
  // overwrites client-supplied x-forwarded-for entirely and places the real
  // client IP leftmost — the two Part 2a gap notes (client-controllable XFF,
  // global-counter ordering) are both resolved: this probe + migration 0005.
  const ip = trustedClientIp(req.headers.get("x-forwarded-for"));
  const visitorId = req.cookies.get(VISITOR_COOKIE)?.value ?? "no-cookie";
  let counts;
  try {
    counts = await recordQuestion(serverSupabase(), visitorKey(ip, visitorId));
  } catch (err) {
    console.error("rate-limit counter failed", { err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
  if (counts.globalCount > GLOBAL_DAILY_LIMIT) {
    return NextResponse.json(
      {
        kind: "rate_limited",
        scope: "global",
        message: "The demo's daily budget is used up — please come back tomorrow.",
      },
      { status: 429 },
    );
  }
  if (counts.visitorCount > VISITOR_DAILY_LIMIT) {
    return NextResponse.json(
      {
        kind: "rate_limited",
        scope: "visitor",
        message: `You've used all ${VISITOR_DAILY_LIMIT} questions for today — come back tomorrow.`,
      },
      { status: 429 },
    );
  }
  const remaining = { visitor: Math.max(0, VISITOR_DAILY_LIMIT - counts.visitorCount) };

  // Parallel decompose-and-retrieve, elapsed-aware soft deadline (spec §3):
  // both calls fire concurrently; the route awaits baseline first (as it
  // always did), then gives decompose only whatever's left of
  // DECOMPOSE_SOFT_DEADLINE_MS since both calls started. If baseline alone
  // already used the whole budget, an already-resolved decompose answer is
  // used for free instead of being discarded by a fixed wall-clock cutoff.
  // decompose() never rejects (lib/decompose.ts) — the only rejection this
  // block can see is from searchChunks, which is fatal today too.
  let retrieval;
  const decomposeStart = Date.now();
  const subsPromise = decompose(question);
  try {
    retrieval = await searchChunks(question, 8);
  } catch (err) {
    console.error("retrieval failed", { question: question.slice(0, 80), err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
  const remainingMs = Math.max(0, DECOMPOSE_SOFT_DEADLINE_MS - (Date.now() - decomposeStart));
  let softTimeoutId: ReturnType<typeof setTimeout>;
  const softTimeout = new Promise<null>((resolve) => {
    softTimeoutId = setTimeout(() => resolve(null), remainingMs);
  });
  const subQuestions = await Promise.race([subsPromise, softTimeout]);
  clearTimeout(softTimeoutId!); // tidy up whichever side didn't win the race

  // Compound path: retrieve per sub-question, merge with the baseline.
  // Every failure lands on the baseline result already in hand (spec §6).
  if (subQuestions && subQuestions.length >= 2) {
    try {
      const subResults = await searchChunksBatch(subQuestions, 8);
      if (subResults.length > 0) retrieval = mergeResults([retrieval, ...subResults]);
    } catch (err) {
      console.error("sub-question retrieval failed", { question: question.slice(0, 80), err });
    }
  }

  // Relevance gate (spec §6.4): off-topic and nonsense input never reaches
  // Claude. Chunks are still returned so the glass box can show why it gated.
  if (!isRelevant(retrieval)) {
    return NextResponse.json({
      kind: "gated",
      message: GATED_MESSAGE,
      chunks: retrieval.chunks,
      maxSimilarity: retrieval.maxSimilarity,
      remaining,
    });
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const gen = streamAnswer(question as string, retrieval.chunks);
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sse("meta", { chunks: retrieval.chunks, remaining })));
        for await (const ev of gen) {
          if (cancelled) break;
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        if (!cancelled) {
          console.error("generation failed mid-stream", {
            question: (question as string).slice(0, 80),
            err,
          });
          controller.enqueue(encoder.encode(sse("error", { message: UPSTREAM_ERROR })));
        }
      } finally {
        if (cancelled) await gen.return(undefined as never);
        else controller.close();
      }
    },
    async cancel() {
      // Client disconnected: flag the loop; the generator's finally aborts
      // the Anthropic stream (Task 2, lib/answer.ts).
      cancelled = true;
      await gen.return(undefined as never);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
