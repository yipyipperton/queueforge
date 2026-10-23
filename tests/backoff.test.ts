import { describe, expect, it } from "vitest";
import { backoffDelay, exponentialDelay } from "@/lib/core/backoff";

const cfg = { baseMs: 1000, capMs: 30_000, jitter: 0.5 };

describe("backoff", () => {
  it("doubles per attempt", () => {
    expect([1, 2, 3, 4, 5].map((a) => exponentialDelay(a, cfg))).toEqual([1000, 2000, 4000, 8000, 16000]);
  });
  it("is capped and overflow-safe", () => {
    expect(exponentialDelay(6, cfg)).toBe(30_000);
    expect(exponentialDelay(10_000, cfg)).toBe(30_000);
    expect(exponentialDelay(0, cfg)).toBe(1000);
  });
  it("jitter stays within [d*(1-j), d] and never exceeds the cap", () => {
    expect(backoffDelay(3, cfg, () => 0)).toBe(2000);
    expect(backoffDelay(3, cfg, () => 1)).toBe(4000);
    expect(backoffDelay(3, cfg, () => 0.5)).toBe(3000);
    for (let i = 0; i < 500; i++) {
      const a = 1 + (i % 12), d = exponentialDelay(a, cfg), v = backoffDelay(a, cfg);
      expect(v).toBeGreaterThanOrEqual(d / 2); expect(v).toBeLessThanOrEqual(Math.min(d, cfg.capMs));
    }
  });
  it("clamps bad rng output", () => {
    expect(backoffDelay(1, cfg, () => 5)).toBe(1000);
    expect(backoffDelay(1, cfg, () => -1)).toBe(500);
  });
});
