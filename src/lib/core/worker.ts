import { claimJobs, Exec, finishJob, Job, reapStale, releaseJob } from "../db/repo";
import { decideOutcome } from "./outcome";
import { JOB_TYPE_SCHEMAS, JobType, simulateJob, Sleep, SimPayload } from "./jobTypes";
import { BackoffConfig, DEFAULT_BACKOFF } from "./backoff";

export interface ProcessOptions {
  limit: number;
  budgetMs: number;
  rng?: () => number;
  sleep?: Sleep;
  now?: () => number;
  backoff?: BackoffConfig;
  leaseSeconds?: number;
}

export interface ProcessResult {
  claimed: number;
  completed: number;
  failed: number;
  deadLettered: number;
  released: number;
  reaped: number;
  elapsedMs: number;
  jobs: { id: string; status: string; attempt: number; durationMs?: number; error?: string }[];
}

/** Worst-case simulated execution time; jobs are only started if they can finish within the budget. */
const MAX_JOB_MS = 2500;

/**
 * Bounded worker pass: one claim (<= limit rows), jobs executed concurrently, hard wall-clock budget.
 * No loops beyond the claimed set, so a single HTTP invocation always terminates.
 */
export async function processBatch(exec: Exec, opts: ProcessOptions): Promise<ProcessResult> {
  const now = opts.now ?? Date.now;
  const start = now();
  const rng = opts.rng ?? Math.random;
  const res: ProcessResult = { claimed: 0, completed: 0, failed: 0, deadLettered: 0, released: 0, reaped: 0, elapsedMs: 0, jobs: [] };

  res.reaped = await reapStale(exec, opts.leaseSeconds ?? 120);
  const claimed = await claimJobs(exec, opts.limit);
  res.claimed = claimed.length;

  await Promise.all(
    claimed.map(async (job: Job) => {
      if (now() - start + MAX_JOB_MS > opts.budgetMs) {
        await releaseJob(exec, job.id, "released: worker time budget exhausted");
        res.released++;
        res.jobs.push({ id: job.id, status: "queued", attempt: job.attempts - 1 });
        return;
      }
      const startedAt = new Date(now());
      let ok: boolean, error: string | null, durationMs: number;
      const schema = JOB_TYPE_SCHEMAS[job.type as JobType];
      const parsed = schema?.safeParse(job.payload);
      if (!parsed?.success) {
        ok = false; error = `invalid payload or unknown type "${job.type}"`; durationMs = 0;
      } else {
        const r = await simulateJob(job.type as JobType, parsed.data as SimPayload, rng, opts.sleep);
        ok = r.ok; error = r.error ?? null; durationMs = r.durationMs;
      }
      const finishedAt = new Date(Math.max(now(), startedAt.getTime() + durationMs));
      const outcome = decideOutcome({ attempts: job.attempts, maxRetries: job.maxRetries, success: ok }, finishedAt, opts.backoff ?? DEFAULT_BACKOFF, rng);
      const updated = await finishJob(exec, job.id, outcome.status, outcome.nextAttemptAt, { attempt: job.attempts, ok, error, startedAt, finishedAt, durationMs });
      if (!updated) return; // lost the lease (reaped) -> do not double-record
      if (outcome.status === "completed") res.completed++;
      else if (outcome.status === "failed") res.failed++;
      else res.deadLettered++;
      res.jobs.push({ id: job.id, status: outcome.status, attempt: job.attempts, durationMs, error: error ?? undefined });
    }),
  );
  res.elapsedMs = now() - start;
  return res;
}
