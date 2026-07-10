import { NextRequest, NextResponse } from "next/server";
import { streamAnswer } from "@/lib/answer";
import {
  GLOBAL_DAILY_LIMIT,
  recordQuestion,
  VISITOR_DAILY_LIMIT,
  visitorKey,
} from "@/lib/rate-limit";
import { isRelevant, searchChunks } from "@/lib/retrieval";
import { SESSION_COOKIE, verifySessionToken, VISITOR_COOKIE } from "@/lib/session";
import { serverSupabase } from "@/lib/supabase";

export const MAX_QUESTION_CHARS = 300;
const GATED_MESSAGE = "I can only answer questions about the Laws of the Game.";
const UPSTREAM_ERROR = "something went wrong, please try again shortly";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function POST(req: NextRequest): Promise<Response> {
  // Defense in depth: the middleware already gates /api/ask, but a matcher
  // typo or config drift must not silently expose the paid path.
  const sessionOk = await verifySessionToken(
    process.env.SESSION_SECRET!,
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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
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

  let retrieval;
  try {
    retrieval = await searchChunks(question, 8);
  } catch (err) {
    console.error("retrieval failed", { question: question.slice(0, 80), err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
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
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sse("meta", { chunks: retrieval.chunks, remaining })));
        for await (const ev of streamAnswer(question as string, retrieval.chunks)) {
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        console.error("generation failed mid-stream", {
          question: (question as string).slice(0, 80),
          err,
        });
        controller.enqueue(encoder.encode(sse("error", { message: UPSTREAM_ERROR })));
      } finally {
        controller.close();
      }
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
