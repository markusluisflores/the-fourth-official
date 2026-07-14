import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordQuestion, trustedClientIp, visitorKey } from "../lib/rate-limit";

const fakeClient = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient;

describe("visitorKey", () => {
  it("is deterministic and 32 hex chars", () => {
    const a = visitorKey("1.2.3.4", "vis-1");
    expect(a).toBe(visitorKey("1.2.3.4", "vis-1"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs when either ip or visitor id differs", () => {
    expect(visitorKey("1.2.3.4", "vis-1")).not.toBe(visitorKey("1.2.3.5", "vis-1"));
    expect(visitorKey("1.2.3.4", "vis-1")).not.toBe(visitorKey("1.2.3.4", "vis-2"));
  });
});

describe("trustedClientIp", () => {
  it("takes the leftmost entry — Railway's edge overwrites the client-supplied value with the real IP as the first entry, and appends its own internal hop(s) after", () => {
    expect(trustedClientIp("209.89.30.136, 152.233.40.2")).toBe("209.89.30.136");
    expect(trustedClientIp("a, b, c")).toBe("a");
  });

  it("handles a single entry and whitespace", () => {
    expect(trustedClientIp(" 209.89.30.136 ")).toBe("209.89.30.136");
  });

  it("falls back for missing or empty headers", () => {
    expect(trustedClientIp(null)).toBe("local");
    expect(trustedClientIp("")).toBe("local");
  });
});

describe("recordQuestion", () => {
  it("returns both counts from the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ visitor_count: 3, global_count: 41 }],
      error: null,
    });
    const counts = await recordQuestion(fakeClient(rpc), "some-key");
    expect(rpc).toHaveBeenCalledWith("record_question", {
      visitor_key: "some-key",
      visitor_limit: 20,
    });
    expect(counts).toEqual({ visitorCount: 3, globalCount: 41 });
  });

  it("passes the visitor limit to the RPC so the DB can gate the global increment", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ visitor_count: 3, global_count: 41 }],
      error: null,
    });
    await recordQuestion(fakeClient(rpc), "some-key");
    expect(rpc).toHaveBeenCalledWith("record_question", {
      visitor_key: "some-key",
      visitor_limit: 20,
    });
  });

  it("throws with context when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(recordQuestion(fakeClient(rpc), "k")).rejects.toThrow(/record_question.*boom/);
  });
});
