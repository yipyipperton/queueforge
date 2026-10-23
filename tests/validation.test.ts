import { describe, expect, it } from "vitest";
import { createJobSchema } from "@/lib/core/schemas";
import { simulateJob } from "@/lib/core/jobTypes";
import { noSleep, seq } from "./helpers";

describe("job validation (whitelist)", () => {
  it("applies defaults", () => {
    const v = createJobSchema.parse({ type: "email.send", payload: {} });
    expect(v.maxRetries).toBe(3);
    expect(v.payload).toMatchObject({ failureProbability: 0.2, durationMs: 300 });
  });
  it("rejects unknown types, extra keys, out-of-range values", () => {
    expect(createJobSchema.safeParse({ type: "shell.exec", payload: {} }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", payload: { url: "http://x" } }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", payload: { failureProbability: 1.5 } }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", payload: { durationMs: 60000 } }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", maxRetries: 50 }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", idempotencyKey: "has space" }).success).toBe(false);
    expect(createJobSchema.safeParse({ type: "email.send", evil: 1 }).success).toBe(false);
  });
  it("reports payload issues with payload path", () => {
    const r = createJobSchema.safeParse({ type: "image.resize", payload: { width: -1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["payload", "width"]);
  });
  it("simulation honours failureProbability", async () => {
    expect((await simulateJob("email.send", { failureProbability: 0, durationMs: 10 }, seq(0.5, 0.99), noSleep)).ok).toBe(true);
    const f = await simulateJob("email.send", { failureProbability: 1, durationMs: 10 }, seq(0.5, 0.0, 0.1), noSleep);
    expect(f.ok).toBe(false); expect(f.error).toMatch(/simulated/);
  });
});
