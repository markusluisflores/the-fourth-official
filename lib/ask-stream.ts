// Pure state machine for one ask cycle (spec §5). The hook feeds it API
// events; components render AskState. No React, no network — fully
// unit-testable.

export type AskPhase =
  | "idle"
  | "submitting"
  | "streaming"
  | "completed"
  | "refused"
  | "failed"
  | "failed_partial"
  | "gated"
  | "limited";

export interface GlassChunk {
  id: number;
  law_number: number;
  breadcrumb: string;
  content: string;
  similarity: number;
  rrf_score: number;
}

// The ruling is a segment list, not a plain string: citation markers land
// exactly where they arrived in the stream, and each marker knows its
// passage number ([1], [2], … assigned per distinct document, first-cited-first).
export type RulingSegment =
  { type: "text"; text: string } | { type: "marker"; passageNumber: number; documentIndex: number };

export interface CitedPassage {
  passageNumber: number;
  documentIndex: number;
  breadcrumb: string;
  citedText: string;
}

export interface AskState {
  phase: AskPhase;
  question: string;
  segments: RulingSegment[];
  passages: CitedPassage[]; // ordered by passageNumber
  chunks: GlassChunk[]; // all retrieved (meta or gated payload)
  maxSimilarity: number | null; // only present on gated responses
  citedDocumentIndexes: number[]; // filled on done
  remaining: number | null; // visitor questions left today
  message: string | null; // gate / limit / error copy from the API
  limitScope: "visitor" | "global" | null;
}

export type AskAction =
  | { type: "submit"; question: string }
  | { type: "meta"; chunks: GlassChunk[]; remaining: { visitor: number } }
  | { type: "text"; delta: string }
  | { type: "citation"; documentIndex: number; citedText: string }
  | { type: "done"; citedDocumentIndexes: number[] }
  | { type: "refusal" }
  | { type: "stream_error"; message: string }
  | {
      type: "gated";
      message: string;
      chunks: GlassChunk[];
      maxSimilarity: number;
      remaining: { visitor: number };
    }
  | { type: "rate_limited"; scope: "visitor" | "global"; message: string }
  | { type: "request_failed"; message: string }
  | { type: "reset" };

export const initialAskState: AskState = {
  phase: "idle",
  question: "",
  segments: [],
  passages: [],
  chunks: [],
  maxSimilarity: null,
  citedDocumentIndexes: [],
  remaining: null,
  message: null,
  limitScope: null,
};

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "submit":
      return {
        ...initialAskState,
        remaining: state.remaining,
        phase: "submitting",
        question: action.question,
      };
    case "meta":
      return {
        ...state,
        phase: "streaming",
        chunks: action.chunks,
        remaining: action.remaining.visitor,
      };
    case "text": {
      const segments = [...state.segments];
      const last = segments[segments.length - 1];
      if (last?.type === "text") {
        segments[segments.length - 1] = { type: "text", text: last.text + action.delta };
      } else {
        segments.push({ type: "text", text: action.delta });
      }
      return { ...state, segments };
    }
    case "citation": {
      const existing = state.passages.find((p) => p.documentIndex === action.documentIndex);
      const passageNumber = existing?.passageNumber ?? state.passages.length + 1;
      const passages = existing
        ? state.passages.map((p) =>
            p.documentIndex === action.documentIndex
              ? { ...p, citedText: `${p.citedText}\n${action.citedText}` }
              : p,
          )
        : [
            ...state.passages,
            {
              passageNumber,
              documentIndex: action.documentIndex,
              breadcrumb: state.chunks[action.documentIndex]?.breadcrumb ?? "",
              citedText: action.citedText,
            },
          ];
      return {
        ...state,
        passages,
        segments: [
          ...state.segments,
          { type: "marker", passageNumber, documentIndex: action.documentIndex },
        ],
      };
    }
    case "done":
      return { ...state, phase: "completed", citedDocumentIndexes: action.citedDocumentIndexes };
    case "refusal":
      return { ...state, phase: "refused", segments: [], passages: [] };
    case "stream_error":
      return { ...state, phase: "failed_partial", message: action.message };
    case "gated":
      return {
        ...state,
        phase: "gated",
        message: action.message,
        chunks: action.chunks,
        maxSimilarity: action.maxSimilarity,
        remaining: action.remaining.visitor,
      };
    case "rate_limited":
      return { ...state, phase: "limited", limitScope: action.scope, message: action.message };
    case "request_failed":
      return { ...state, phase: "failed", message: action.message };
    case "reset":
      return { ...initialAskState, remaining: state.remaining };
  }
}
