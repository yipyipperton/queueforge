import { sql, type SQL } from "drizzle-orm";
import type { JobStatus } from "../core/states";
import type { CreateJobInput } from "../core/schemas";

/**
 * Thin executor abstraction: anything that can run a drizzle SQL fragment and return rows.
 * Production uses Neon HTTP; tests use PGlite (real Postgres in WASM). Every multi-row mutation is a
 * single SQL statement (CTEs) so it is atomic even over the stateless Neon HTTP driver.
 */
export type Exec = (q: SQL) => Promise<Record<string, unknown>[]>;

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxRetries: number;
  idempotencyKey: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

export function mapJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    type: String(r.type),
    payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
    status: r.status as JobStatus,
    attempts: Number(r.attempts),
    maxRetries: Number(r.max_retries),
    idempotencyKey: (r.idempotency_key as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    nextAttemptAt: iso(r.next_attempt_at)!,
    lockedAt: iso(r.locked_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    completedAt: iso(r.completed_at),
  };
}

/** Insert a job. With an idempotency key, ON CONFLICT returns the existing job instead of creating a duplicate. */
export async function insertJob(exec: Exec, input: CreateJobInput): Promise<{ job: Job; created: boolean }> {
  const payload = JSON.stringify(input.payload);
  const key = input.idempotencyKey ?? null;
  const rows = await exec(sql`
    with ins as (
      insert into jobs (type, payload, max_retries, idempotency_key)
      values (${input.type}, ${payload}::jsonb, ${input.maxRetries}, ${key})
      on conflict (idempotency_key) do nothing
      returning *
    ), ev as (
      insert into job_events (job_id, from_status, to_status, reason)
      select id, null, 'queued', 'submitted' from ins
    )
    select *, true as created from ins
    union all
    select *, false as created from jobs where ${key}::text is not null and idempotency_key = ${key} and not exists (select 1 from ins)
  `);
  if (!rows[0]) {
    // Concurrent insert race: the conflicting row was not yet visible to our snapshot; read it now.
    const again = await exec(sql`select * from jobs where idempotency_key = ${key}`);
    if (!again[0]) throw new Error("idempotent insert failed");
    return { job: mapJob(again[0]), created: false };
  }
  return { job: mapJob(rows[0]), created: Boolean(rows[0].created) };
}

export async function getJob(exec: Exec, id: string) {
  const [row] = await exec(sql`select * from jobs where id = ${id}`);
  if (!row) return null;
  const events = await exec(sql`select from_status, to_status, reason, at from job_events where job_id = ${id} order by at, id`);
  const attempts = await exec(sql`select attempt, outcome, error, started_at, finished_at, duration_ms from job_attempts where job_id = ${id} order by attempt, id`);
  return {
    job: mapJob(row),
    events: events.map((e) => ({ from: (e.from_status as string) ?? null, to: String(e.to_status), reason: (e.reason as string) ?? null, at: iso(e.at)! })),
    attempts: attempts.map((a) => ({ attempt: Number(a.attempt), outcome: String(a.outcome), error: (a.error as string) ?? null, startedAt: iso(a.started_at)!, finishedAt: iso(a.finished_at)!, durationMs: Number(a.duration_ms) })),
  };
}

export async function listJobs(exec: Exec, f: { status?: JobStatus; type?: string; limit: number; before?: string }) {
  const where: SQL[] = [sql`true`];
  if (f.status) where.push(sql`status = ${f.status}`);
  if (f.type) where.push(sql`type = ${f.type}`);
  if (f.before) where.push(sql`created_at < ${f.before}::timestamptz`);
  const rows = await exec(sql`select * from jobs where ${sql.join(where, sql` and `)} order by created_at desc, id desc limit ${f.limit}`);
  return rows.map(mapJob);
}

/**
 * Atomically claim up to `limit` due jobs. FOR UPDATE SKIP LOCKED guarantees two concurrent workers never
 * claim the same row; the status guard + CHECK constraint enforce queued|failed -> processing only.
 */
export async function claimJobs(exec: Exec, limit: number): Promise<(Job & { prevStatus: JobStatus })[]> {
  const rows = await exec(sql`
    with picked as (
      select id, status from jobs
      where status in ('queued','failed') and next_attempt_at <= now()
      order by next_attempt_at, created_at
      limit ${limit}
      for update skip locked
    ), claimed as (
      update jobs j set status = 'processing', attempts = j.attempts + 1, locked_at = now(), updated_at = now()
      from picked p
      where j.id in (select id from picked) and j.id = p.id
      returning j.*, p.status as prev_status
    ), ev as (
      insert into job_events (job_id, from_status, to_status, reason)
      select id, prev_status, 'processing', 'claimed (attempt ' || attempts || ')' from claimed
    )
    select * from claimed
  `);
  return rows.map((r) => ({ ...mapJob(r), prevStatus: r.prev_status as JobStatus }));
}

export interface AttemptRecord {
  attempt: number;
  ok: boolean;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

/** processing -> completed|failed|dead_lettered, recording the attempt and the transition in one statement. */
export async function finishJob(exec: Exec, id: string, to: "completed" | "failed" | "dead_lettered", nextAttemptAt: Date | null, a: AttemptRecord) {
  const reason = to === "completed" ? "attempt succeeded" : to === "failed" ? "attempt failed, retry scheduled" : "retries exhausted";
  const rows = await exec(sql`
    with u as (
      update jobs set status = ${to}, last_error = ${a.error}::text, locked_at = null, updated_at = now(),
        next_attempt_at = coalesce(${nextAttemptAt?.toISOString() ?? null}::timestamptz, next_attempt_at),
        completed_at = case when ${to}::text = 'completed' then now() else completed_at end
      where id = ${id} and status = 'processing' and attempts = ${a.attempt}
      returning *
    ), at as (
      insert into job_attempts (job_id, attempt, outcome, error, started_at, finished_at, duration_ms)
      select id, ${a.attempt}::int, ${a.ok ? "success" : "failure"}::text, ${a.error}::text, ${a.startedAt.toISOString()}::timestamptz, ${a.finishedAt.toISOString()}::timestamptz, ${a.durationMs}::int from u
    ), ev as (
      insert into job_events (job_id, from_status, to_status, reason)
      select id, 'processing', ${to}::text, ${reason}::text from u
    )
    select * from u
  `);
  return rows[0] ? mapJob(rows[0]) : null;
}

/** processing -> queued without counting the attempt (worker ran out of time budget before executing). */
export async function releaseJob(exec: Exec, id: string, reason: string) {
  const rows = await exec(sql`
    with u as (
      update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_at = null, updated_at = now()
      where id = ${id} and status = 'processing' returning *
    ), ev as (insert into job_events (job_id, from_status, to_status, reason) select id, 'processing', 'queued', ${reason}::text from u)
    select * from u
  `);
  return rows[0] ? mapJob(rows[0]) : null;
}

/** Lease expiry: a worker crashed mid-job. processing -> failed (counts as a failed attempt; retried later). */
export async function reapStale(exec: Exec, leaseSeconds: number) {
  const rows = await exec(sql`
    with u as (
      update jobs set status = case when attempts >= max_retries + 1 then 'dead_lettered' else 'failed' end,
        last_error = 'lease expired (worker did not report back)', locked_at = null, updated_at = now(), next_attempt_at = now()
      where status = 'processing' and locked_at < now() - make_interval(secs => ${leaseSeconds})
      returning *
    ), ev as (insert into job_events (job_id, from_status, to_status, reason) select id, 'processing', status, 'lease expired' from u)
    select id from u
  `);
  return rows.length;
}

/** Manual DLQ retry: dead_lettered -> queued with a fresh attempt budget. */
export async function retryDeadLetter(exec: Exec, id: string) {
  const rows = await exec(sql`
    with u as (
      update jobs set status = 'queued', attempts = 0, next_attempt_at = now(), locked_at = null, updated_at = now()
      where id = ${id} and status = 'dead_lettered' returning *
    ), ev as (insert into job_events (job_id, from_status, to_status, reason) select id, 'dead_lettered', 'queued', 'manual retry from DLQ' from u)
    select * from u
  `);
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function metrics(exec: Exec) {
  const [counts] = await exec(sql`
    select
      count(*) filter (where status in ('queued','processing','failed'))::int as active,
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'processing')::int as processing,
      count(*) filter (where status = 'failed')::int as retrying,
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'dead_lettered')::int as dead_lettered,
      count(*)::int as total
    from jobs`);
  const [att] = await exec(sql`
    select count(*) filter (where outcome = 'success')::int as ok, count(*) filter (where outcome = 'failure')::int as failed,
      coalesce(percentile_cont(0.5) within group (order by duration_ms), 0)::float as p50,
      coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float as p95
    from job_attempts where finished_at > now() - interval '24 hours'`);
  const series = await exec(sql`
    select date_trunc('minute', finished_at) as bucket,
      count(*) filter (where outcome = 'success')::int as ok,
      count(*) filter (where outcome = 'failure')::int as failed,
      coalesce(percentile_cont(0.5) within group (order by duration_ms), 0)::float as p50,
      coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float as p95
    from job_attempts where finished_at > now() - interval '60 minutes'
    group by 1 order by 1`);
  const ok = Number(att.ok), failed = Number(att.failed);
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])) as Record<string, number>,
    attempts24h: { ok, failed, successRate: ok + failed ? ok / (ok + failed) : null, p50: Number(att.p50), p95: Number(att.p95) },
    series: series.map((s) => ({ t: iso(s.bucket)!, ok: Number(s.ok), failed: Number(s.failed), p50: Math.round(Number(s.p50)), p95: Math.round(Number(s.p95)) })),
  };
}

/** Fixed-window rate limit, stored in Postgres (works across serverless instances). Returns remaining or -1 if limited. */
export async function rateLimit(exec: Exec, key: string, max: number, windowSec: number): Promise<{ allowed: boolean; count: number; resetAt: string }> {
  const [r] = await exec(sql`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.window_start end
    returning count, window_start`);
  const count = Number(r.count);
  return { allowed: count <= max, count, resetAt: new Date(new Date(r.window_start as string).getTime() + windowSec * 1000).toISOString() };
}
