import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordQuestion, visitorKey } from "../lib/rate-limit";

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

describe("recordQuestion", () => {
  it("returns both counts from the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ visitor_count: 3, global_count: 41 }],
      error: null,
    });
    const counts = await recordQuestion(fakeClient(rpc), "some-key");
    expect(rpc).toHaveBeenCalledWith("record_question", { visitor_key: "some-key" });
    expect(counts).toEqual({ visitorCount: 3, globalCount: 41 });
  });

  it("throws with context when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(recordQuestion(fakeClient(rpc), "k")).rejects.toThrow(/record_question.*boom/);
  });
});
