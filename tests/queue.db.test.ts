import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { claimJobs, Exec, getJob, insertJob, listJobs, metrics, rateLimit, retryDeadLetter } from "@/lib/db/repo";
import { createJobSchema } from "@/lib/core/schemas";
import { processBatch } from "@/lib/core/worker";
import { noSleep, testDb } from "./helpers";

const cfg = { baseMs: 1000, capMs: 10000, jitter: 0 };
let exec: Exec, makeDue: () => Promise<unknown>;
const job = (o: Record<string, unknown> = {}) => createJobSchema.parse({ type: "email.send", payload: { failureProbability: 0, durationMs: 0 }, ...o });
const run = (limit = 10) => processBatch(exec, { limit, budgetMs: 10_000, sleep: noSleep, backoff: cfg, rng: () => 0.5 });

beforeEach(async () => { ({ exec, makeDue } = await testDb()); });

describe("idempotency", () => {
  it("duplicate submission returns the existing job", async () => {
    const a = await insertJob(exec, job({ idempotencyKey: "order-42" }));
    const b = await insertJob(exec, job({ idempotencyKey: "order-42", maxRetries: 9 }));
    expect(a.created).toBe(true); expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id); expect(b.job.maxRetries).toBe(3);
    expect(await listJobs(exec, { limit: 50 })).toHaveLength(1);
  });
  it("concurrent duplicates create exactly one job", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => insertJob(exec, job({ idempotencyKey: "k" }))));
    expect(new Set(rs.map((r) => r.job.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });
  it("jobs without a key are never deduplicated", async () => {
    await insertJob(exec, job()); await insertJob(exec, job());
    expect(await listJobs(exec, { limit: 50 })).toHaveLength(2);
  });
  it("duplicate submission does not cause duplicate execution", async () => {
    await insertJob(exec, job({ idempotencyKey: "once" })); await run();
    await insertJob(exec, job({ idempotencyKey: "once" }));
    expect((await run()).claimed).toBe(0);
    const [{ n }] = await exec(sql`select count(*)::int as n from job_attempts`);
    expect(n).toBe(1);
  });
});

describe("claiming", () => {
  it("claims at most N and never the same job twice concurrently", async () => {
    for (let i = 0; i < 6; i++) await insertJob(exec, job());
    const [a, b] = await Promise.all([claimJobs(exec, 4), claimJobs(exec, 4)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(a.length).toBeLessThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length); expect(ids.length).toBe(6);
    expect(a.every((j) => j.status === "processing" && j.attempts === 1)).toBe(true);
  });
  it("does not claim jobs whose next_attempt_at is in the future", async () => {
    const { job: j } = await insertJob(exec, job());
    await exec(sql`update jobs set next_attempt_at = now() + interval '1 hour' where id = ${j.id}`);
    expect(await claimJobs(exec, 10)).toHaveLength(0);
  });
});

describe("retry, backoff & DLQ", () => {
  it("success path records transitions and an attempt", async () => {
    const { job: j } = await insertJob(exec, job());
    expect((await run()).completed).toBe(1);
    const d = (await getJob(exec, j.id))!;
    expect(d.job.status).toBe("completed"); expect(d.job.completedAt).not.toBeNull();
    expect(d.events.map((e) => e.to)).toEqual(["queued", "processing", "completed"]);
    expect(d.attempts).toHaveLength(1);
  });
  it("failure schedules backoff, then exhausts to dead_lettered after maxRetries+1 attempts", async () => {
    const { job: j } = await insertJob(exec, job({ maxRetries: 2, payload: { failureProbability: 1, durationMs: 0 } }));
    const r1 = await run(); expect(r1.failed).toBe(1);
    let d = (await getJob(exec, j.id))!;
    expect(d.job.status).toBe("failed"); expect(d.job.lastError).toMatch(/simulated/);
    const delay = new Date(d.job.nextAttemptAt).getTime() - new Date(d.attempts[0].finishedAt).getTime();
    expect(delay).toBe(1000);
    expect((await run()).claimed).toBe(0); // not due yet
    await makeDue(); expect((await run()).failed).toBe(1);
    d = (await getJob(exec, j.id))!;
    expect(new Date(d.job.nextAttemptAt).getTime() - new Date(d.attempts[1].finishedAt).getTime()).toBe(2000);
    await makeDue(); expect((await run()).deadLettered).toBe(1);
    d = (await getJob(exec, j.id))!;
    expect(d.job.status).toBe("dead_lettered"); expect(d.job.attempts).toBe(3);
    expect(d.attempts.map((a) => a.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(d.events.map((e) => e.to)).toEqual(["queued", "processing", "failed", "processing", "failed", "processing", "dead_lettered"]);
    await makeDue(); expect((await run()).claimed).toBe(0); // DLQ is never auto-claimed
  });
  it("manual DLQ retry re-queues with a fresh attempt budget; only from dead_lettered", async () => {
    const { job: j } = await insertJob(exec, job({ maxRetries: 0, payload: { failureProbability: 1, durationMs: 0 } }));
    expect(await retryDeadLetter(exec, j.id)).toBeNull(); // queued -> queued not allowed
    await run();
    const r = await retryDeadLetter(exec, j.id);
    expect(r?.status).toBe("queued"); expect(r?.attempts).toBe(0);
    expect(await retryDeadLetter(exec, j.id)).toBeNull();
    expect((await run()).claimed).toBe(1);
    const d = (await getJob(exec, j.id))!;
    expect(d.events.some((e) => e.from === "dead_lettered" && e.to === "queued")).toBe(true);
  });
  it("DB rejects invalid status values", async () => {
    const { job: j } = await insertJob(exec, job());
    await expect(exec(sql`update jobs set status = 'bogus' where id = ${j.id}`)).rejects.toThrow();
  });
  it("time budget releases claimed jobs back to queued without consuming an attempt", async () => {
    await insertJob(exec, job());
    const r = await processBatch(exec, { limit: 5, budgetMs: 1000, sleep: noSleep });
    expect(r.released).toBe(1);
    const [j] = await listJobs(exec, { limit: 1 });
    expect(j.status).toBe("queued"); expect(j.attempts).toBe(0);
  });
  it("stale leases are reaped", async () => {
    const { job: j } = await insertJob(exec, job());
    await claimJobs(exec, 1);
    await exec(sql`update jobs set locked_at = now() - interval '1 hour' where id = ${j.id}`);
    const r = await run();
    expect(r.reaped).toBe(1);
    expect(r.completed).toBe(1); // reaped -> failed (due now) -> claimed again in the same pass
  });
});

describe("metrics & rate limit", () => {
  it("computes counts and success rate from stored attempts", async () => {
    await insertJob(exec, job()); await insertJob(exec, job({ maxRetries: 0, payload: { failureProbability: 1, durationMs: 0 } }));
    await run();
    const m = await metrics(exec);
    expect(m.counts).toMatchObject({ completed: 1, dead_lettered: 1, active: 0, total: 2 });
    expect(m.attempts24h.successRate).toBe(0.5);
    expect(m.series.length).toBeGreaterThan(0);
  });
  it("rate limits per key in a fixed window", async () => {
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push((await rateLimit(exec, "ip:1", 3, 60)).allowed);
    expect(rs).toEqual([true, true, true, false]);
    expect((await rateLimit(exec, "ip:2", 3, 60)).allowed).toBe(true);
  });
});
