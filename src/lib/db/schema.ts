import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    idempotencyKey: text("idempotency_key"),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_key_uq").on(t.idempotencyKey),
    index("jobs_claim_idx").on(t.status, t.nextAttemptAt),
    index("jobs_created_idx").on(t.createdAt),
    check("jobs_status_ck", sql`${t.status} in ('queued','processing','completed','failed','dead_lettered')`),
    check("jobs_attempts_ck", sql`${t.attempts} >= 0 and ${t.maxRetries} >= 0`),
  ],
);

/** Every state transition (audit log). */
export const jobEvents = pgTable(
  "job_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_events_job_idx").on(t.jobId, t.at)],
);

/** Execution history: one row per attempt, durations drive latency charts. */
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(), // success | failure
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("job_attempts_job_idx").on(t.jobId), index("job_attempts_finished_idx").on(t.finishedAt)],
);

/** Fixed-window, per-key (IP + route) rate limit counters. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});
