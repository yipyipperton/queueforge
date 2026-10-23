import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError, JOB_STATUSES, isTerminal } from "@/lib/core/states";
import { decideOutcome } from "@/lib/core/outcome";

describe("state machine", () => {
  it("allows the documented lifecycle", () => {
    for (const [a, b] of [["queued", "processing"], ["processing", "completed"], ["processing", "failed"], ["failed", "processing"], ["processing", "dead_lettered"], ["dead_lettered", "queued"], ["processing", "queued"]] as const)
      expect(canTransition(a, b)).toBe(true);
  });
  it("rejects illegal transitions", () => {
    for (const [a, b] of [["queued", "completed"], ["completed", "queued"], ["completed", "processing"], ["failed", "completed"], ["dead_lettered", "processing"], ["queued", "dead_lettered"]] as const) {
      expect(canTransition(a, b)).toBe(false);
      expect(() => assertTransition(a, b)).toThrow(InvalidTransitionError);
    }
  });
  it("has no self-transitions and only completed is terminal", () => {
    for (const s of JOB_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(["completed"]);
  });
  it("decideOutcome maps results to legal processing exits", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(decideOutcome({ attempts: 1, maxRetries: 3, success: true }, now).status).toBe("completed");
    const f = decideOutcome({ attempts: 1, maxRetries: 3, success: false }, now, { baseMs: 1000, capMs: 10000, jitter: 0 });
    expect(f).toMatchObject({ status: "failed", delayMs: 1000 });
    expect(f.nextAttemptAt?.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(decideOutcome({ attempts: 4, maxRetries: 3, success: false }, now).status).toBe("dead_lettered");
    expect(decideOutcome({ attempts: 1, maxRetries: 0, success: false }, now).status).toBe("dead_lettered");
  });
});
