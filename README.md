# QueueForge

A durable, Postgres-backed background job queue with retries, exponential backoff, idempotent submission, a dead-letter queue, and a dark operator console — built as a production-style reference on **Next.js (App Router) · TypeScript (strict) · Tailwind + shadcn/ui · Neon Postgres · Drizzle ORM · Zod · Vitest · Recharts · Vercel**.

All state (jobs, state transitions, attempts, rate-limit counters) lives in Postgres. There is no in-memory storage anywhere.

---

## Architecture

```
 Browser console (client component, polls every 2.5s)
   │  GET /api/jobs, /api/jobs/:id, /api/metrics           (public, read-only)
   │  POST /api/demo/{seed,process,retry/:id}              (public, per-IP rate limited, capped)
   ▼
 Next.js route handlers (Node runtime, src/app/api/**)
   │  Zod validation → repo functions (src/lib/db/repo.ts)
   │  POST /api/jobs, /api/worker/process, /api/jobs/:id/retry   (Bearer ADMIN_TOKEN)
   ▼
 Worker pass (src/lib/core/worker.ts) — bounded: 1 claim, ≤ N jobs, wall-clock budget
   ▼
 Neon Postgres (HTTP driver)  ── jobs · job_events · job_attempts · rate_limits
```

**Layers**

| Path | Responsibility |
|---|---|
| `src/lib/core/states.ts` | State machine: allowed transitions, `assertTransition` |
| `src/lib/core/backoff.ts` | Exponential backoff with cap + bounded jitter |
| `src/lib/core/outcome.ts` | Pure decision: success / retry (with `next_attempt_at`) / dead-letter |
| `src/lib/core/jobTypes.ts` | Whitelisted **simulated** job types, payload schemas, simulator |
| `src/lib/core/schemas.ts` | Zod request contracts |
| `src/lib/core/worker.ts` | Bounded worker pass (reap → claim → execute concurrently → finish) |
| `src/lib/db/schema.ts` | Drizzle schema (source of migrations in `drizzle/`) |
| `src/lib/db/repo.ts` | All SQL. Takes an injected `Exec` so tests run against PGlite |
| `src/lib/server/http.ts` | Auth, DB-not-configured handling, rate limiting, error mapping |
| `src/components/*` | Console UI (shadcn-style primitives in `components/ui`) |

### State machine

```
           submit
             │
             ▼
 ┌──────► queued ──claim──► processing ──success──► completed (terminal)
 │           ▲                 │   │
 │  released │(budget)         │   └─failure, attempts > maxRetries──► dead_lettered
 │           └─────────────────┤                                          │
 │                             └─failure, retries left──► failed          │
 │                                     (next_attempt_at = now + backoff)  │
 │                                        │ claim when due                │
 │                                        └──────► processing             │
 └─────────────────────────── manual retry (operator) ────────────────────┘
```

`failed` means "attempt failed, waiting for retry" (shown as *retrying* in the UI). Transitions are enforced three ways: the pure `TRANSITIONS` table (`assertTransition` is called on every worker decision), status guards in every `UPDATE ... WHERE status = '<from>'`, and a `CHECK` constraint on allowed status values. Every transition is written to `job_events` **in the same SQL statement** as the status change (data-modifying CTEs), so the audit log can't drift from the row.

### Claiming (no double execution)

```sql
with picked as (
  select id, status from jobs
  where status in ('queued','failed') and next_attempt_at <= now()
  order by next_attempt_at, created_at
  limit $N
  for update skip locked
), claimed as (
  update jobs j set status='processing', attempts=j.attempts+1, locked_at=now(), updated_at=now()
  from picked p where j.id in (select id from picked) and j.id = p.id
  returning j.*, p.status as prev_status
), ev as (insert into job_events ... select ... from claimed)
select * from claimed;
```

Concurrent workers skip each other's locked rows. Completion is guarded by `status='processing' AND attempts=<claimed attempt>`, so a worker whose lease was reaped can't overwrite a newer attempt.

### Bounded worker

`POST /api/worker/process` does **one** pass: reap expired leases (default 120s) → claim ≤ `limit` (max 25) → run claimed jobs concurrently → finish. A job is only started if it can finish within `budgetMs` (max 20s, worst-case job time 2.5s); otherwise it's released back to `queued` without consuming an attempt. No loops, no recursion: the request always terminates. Drive it from Vercel Cron / an external scheduler / the console button.

### Retries & backoff

`delay(attempt) = min(cap, base · 2^(attempt-1))`, then "equal jitter": `delay·(1-j) + delay·j·rand`, `j = 0.5`, so the result is in `[delay/2, delay]` and never above the cap. Defaults `base = 2s`, `cap = 5min` (`QF_BACKOFF_BASE_MS`, `QF_BACKOFF_CAP_MS`). `maxRetries` (0–10, default 3) is the number of retries **after** the first attempt; when `attempts ≥ maxRetries + 1` and the attempt fails, the job goes to `dead_lettered`. DLQ jobs are never auto-claimed; manual retry resets `attempts` to 0 and re-queues.

### Idempotency

`jobs.idempotency_key` has a unique index. Submission is `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, falling back to selecting the existing row (also handling the concurrent-insert race). The existing job is returned with `200` and `"created": false`; new jobs get `201`. Because the job is not duplicated, it is not executed twice. Jobs without a key are never de-duplicated.

### Failure simulation (safe by construction)

Only these types exist; payloads are `.strict()` Zod objects (unknown keys rejected). Nothing executes user code or performs network I/O:

| type | extra payload fields |
|---|---|
| `email.send` | `to` (email), `template` |
| `image.resize` | `width`, `height` (1–8192) |
| `report.generate` | `reportId`, `rows` |
| `webhook.simulate` | `event` (no HTTP is made) |

Common fields: `failureProbability` 0–1 (default 0.2), `durationMs` 0–2000 (default 300; ±25% jitter at run time).

### Auth & abuse controls

* **Admin** (`Authorization: Bearer $ADMIN_TOKEN`, constant-time compare): `POST /api/jobs`, `POST /api/worker/process`, `POST /api/jobs/:id/retry`. If `ADMIN_TOKEN` is unset these return `503 admin_not_configured` (fail closed).
* **Public demo** routes used by the console, rate limited per client network (IPv4 /24, IPv6 /64 — so rotating proxy/privacy addresses share a bucket) with a fixed-window counter in the `rate_limits` table (works across serverless instances): seed ≤ 12 jobs/call, 10 calls/min; process limit 10 / 8s budget, 20 calls/min; DLQ retry 30/min.
* Reads (`GET`) are public — this is a demo console. Put the app behind Vercel auth / SSO if job data is sensitive.

---

## API contracts

All responses are JSON with `cache-control: no-store`. Errors: `{ "error": { "code", "message", ... } }`.
Codes: `validation_error` (400, with Zod `issues`), `invalid_json`, `invalid_id` (400), `unauthorized` (401), `not_found` (404), `invalid_state` (409), `rate_limited` (429, `retry-after` header), `database_not_configured` / `admin_not_configured` (503), `internal_error` (500).

### `POST /api/jobs` (admin)
```json
{ "type": "email.send", "payload": { "failureProbability": 0.3, "durationMs": 400, "to": "a@b.co" },
  "maxRetries": 3, "idempotencyKey": "order-123:welcome" }
```
`idempotencyKey`: optional, 1–128 chars `[A-Za-z0-9._:-]`. → `201 { job, created: true }` or `200 { job, created: false }` (existing job).

### `GET /api/jobs?status=&type=&limit=50&before=<iso>`
→ `{ jobs: Job[], nextCursor: string|null }` (newest first; pass `nextCursor` as `before`).

### `GET /api/jobs/:id`
→ `{ job, events: [{from,to,reason,at}], attempts: [{attempt,outcome,error,startedAt,finishedAt,durationMs}] }`

### `POST /api/jobs/:id/retry` (admin) — DLQ → queued. `409` if not dead-lettered.

### `POST /api/worker/process` (admin)
Body `{ "limit": 10, "budgetMs": 8000 }` (limit 1–25, budget 500–20000) →
`{ claimed, completed, failed, deadLettered, released, reaped, elapsedMs, jobs: [...] }`

### `GET /api/metrics`
→ `{ counts: {active,queued,processing,retrying,completed,dead_lettered,total}, attempts24h: {ok,failed,successRate,p50,p95}, series: [{t,ok,failed,p50,p95}] }` (per-minute, last 60 min, from `job_attempts`).

### `GET /api/health` → `{ ok, database: connected|connected_unmigrated|not_configured|unreachable, adminConfigured }`

### Demo (public, rate limited)
`POST /api/demo/seed {count≤12}` · `POST /api/demo/process` · `POST /api/demo/retry/:id`

`Job` shape: `{ id, type, payload, status, attempts, maxRetries, idempotencyKey, lastError, nextAttemptAt, lockedAt, createdAt, updatedAt, completedAt }`.

---

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string (pooled is fine — the app uses Neon's HTTP driver). Injected automatically by the Vercel ↔ Neon Marketplace integration. Without it the app runs and shows a **"Database not configured"** state; all data APIs return `503 database_not_configured`. |
| `ADMIN_TOKEN` | yes for admin API | Bearer token for worker/admin endpoints. Use a long random value (`openssl rand -hex 24`). |
| `QF_BACKOFF_BASE_MS` | no | Backoff base (default 2000) |
| `QF_BACKOFF_CAP_MS` | no | Backoff cap (default 300000) |

The Neon integration also injects `DATABASE_URL_UNPOOLED`, `PG*`, `POSTGRES_*` — unused by the app, harmless.

---

## Local setup

```bash
npm install
cp .env.example .env.local      # fill DATABASE_URL (a Neon branch or any Postgres 14+) and ADMIN_TOKEN
npm run db:migrate              # applies drizzle/ migrations
npm run dev                     # http://localhost:3000
```

Scripts: `npm run typecheck` · `npm test` (Vitest) · `npm run build` · `npm run db:generate` (after editing `schema.ts`) · `npm run db:migrate`.

### Tests

`npm test` runs 29 tests. Pure units cover the state machine, backoff math (bounds, cap, overflow, jitter clamping), outcome decisions and Zod validation. The DB layer is tested against **PGlite** (real Postgres compiled to WASM) with the production migrations applied, covering: idempotent & concurrent duplicate submission, no duplicate execution, bounded claiming, not-yet-due jobs, full retry → backoff → DLQ lifecycle with exact delays, manual DLQ retry rules, the DB `CHECK` constraint, time-budget release, lease reaping, metrics and rate limiting. No network or Neon account needed.

## Deployment (Vercel + Neon)

1. Import the repo in Vercel (or `vercel link`).
2. Connect Neon: Vercel → Project → **Storage → Create → Neon** (or `vercel integration add neon`). This sets `DATABASE_URL`.
3. Add `ADMIN_TOKEN` (Production + Preview).
4. Run migrations once against that DB: `vercel env pull .env.local && set -a && . ./.env.local && set +a && npm run db:migrate`.
5. Deploy: `vercel --prod`.
6. Optional: schedule the worker (Vercel Cron or any scheduler) to `POST /api/worker/process` with the bearer token. Note: Vercel Cron sends `GET` with `CRON_SECRET`; wrap or use an external scheduler.

Example:
```bash
curl -X POST "$URL/api/jobs" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"report.generate","payload":{"failureProbability":0.5},"maxRetries":2,"idempotencyKey":"r-1"}'
curl -X POST "$URL/api/worker/process" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"limit":10}'
```

---

## Tradeoffs

* **Postgres as the queue** (vs. SQS/Redis): one system of record, transactional state + audit, `SKIP LOCKED` gives safe concurrency. Fine for thousands of jobs/min; not for very high fan-out.
* **Neon HTTP driver** has no interactive transactions, so every multi-table mutation is a single statement with data-modifying CTEs — atomic, one round trip.
* **Pull-based, request-scoped worker**: serverless-friendly and bounded, but throughput depends on how often it's triggered. No long-running daemon.
* **At-least-once semantics**: if a worker dies after executing but before recording, the lease reaper retries the job. Real handlers must be idempotent.
* **Fixed-window rate limiting** in Postgres: simple and shared across instances; allows bursts at window edges and adds a write per demo request.
* **Polling UI** (2.5s) instead of SSE/websockets: simple and cache-free on serverless.

## Limitations

* Job handlers are simulations only (by design); there's no plugin system for real handlers.
* Idempotency keys are global and permanent (no TTL), and a duplicate with a *different* payload returns the original job rather than a 422 conflict.
* No priorities, scheduled/delayed submission, per-type concurrency limits, or job cancellation.
* Metrics are computed on read from `job_attempts` (indexed by `finished_at`); at large volume you'd pre-aggregate.
* Public reads expose demo job data; admin auth is a single shared bearer token (no RBAC/rotation).
* Concurrency tests run on PGlite (single connection), which serializes statements; `SKIP LOCKED` behaviour under true parallel connections is verified only against a real Postgres.
