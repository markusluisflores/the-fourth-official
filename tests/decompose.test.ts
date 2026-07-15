import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  decompose,
  DECOMPOSE_MODEL,
  DECOMPOSE_TIMEOUT_MS,
  MAX_SUB_QUESTIONS,
  parseSubQuestions,
} from "../lib/decompose";

const fakeClient = (create: ReturnType<typeof vi.fn>) =>
  ({ messages: { create } }) as unknown as Anthropic;

const okResponse = (subs: unknown) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ sub_questions: subs }) }],
});

describe("parseSubQuestions", () => {
  it("returns a valid 2-4 way split", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["a?", "b?", "c?"] }))).toEqual([
      "a?",
      "b?",
      "c?",
    ]);
  });

  it("returns a single-question array unchanged", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["only?"] }))).toEqual(["only?"]);
  });

  it("trims entries and drops empty/whitespace-only strings", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["  a?  ", "", "   "] }))).toEqual([
      "a?",
    ]);
  });

  it("drops non-string entries", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["a?", 7, null] }))).toEqual(["a?"]);
  });

  it("caps at MAX_SUB_QUESTIONS by keeping the first ones", () => {
    const six = ["a?", "b?", "c?", "d?", "e?", "f?"];
    expect(parseSubQuestions(JSON.stringify({ sub_questions: six }))).toEqual(
      six.slice(0, MAX_SUB_QUESTIONS),
    );
  });

  it("returns null for non-JSON, wrong shape, and empty list", () => {
    expect(parseSubQuestions("not json")).toBeNull();
    expect(parseSubQuestions(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parseSubQuestions(JSON.stringify({ sub_questions: [] }))).toBeNull();
    expect(parseSubQuestions(JSON.stringify(null))).toBeNull();
  });
});

describe("decompose", () => {
  it("returns sub-questions on the happy path and sends the question as user data", async () => {
    const create = vi.fn().mockResolvedValue(okResponse(["a?", "b?"]));
    const result = await decompose("compound question?", fakeClient(create));
    expect(result).toEqual(["a?", "b?"]);
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe(DECOMPOSE_MODEL);
    expect(params.messages).toEqual([{ role: "user", content: "compound question?" }]);
    // Spec §8: the visitor's question must never be in the system prompt.
    expect(params.system).not.toContain("compound question?");
    // Spec §6: hard budget, no retries — fall back instead of retrying.
    expect(options).toMatchObject({ timeout: DECOMPOSE_TIMEOUT_MS, maxRetries: 0 });
  });

  it("returns null on a refusal stop reason", async () => {
    const create = vi.fn().mockResolvedValue({ ...okResponse(["a?"]), stop_reason: "refusal" });
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });

  it("returns null when the call rejects (errors and timeouts)", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timed out"));
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });

  it("returns null when the response has no text block", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [] });
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });
});
