import { z } from "zod";

/** Fixed whitelist of SIMULATED job types. Nothing here executes user code or makes network calls. */
const base = {
  failureProbability: z.number().min(0).max(1).default(0.2),
  durationMs: z.number().int().min(0).max(2000).default(300),
};

export const JOB_TYPE_SCHEMAS = {
  "email.send": z.object({ ...base, to: z.string().email().max(200).default("demo@example.com"), template: z.string().max(64).default("welcome") }).strict(),
  "image.resize": z.object({ ...base, width: z.number().int().min(1).max(8192).default(640), height: z.number().int().min(1).max(8192).default(480) }).strict(),
  "report.generate": z.object({ ...base, reportId: z.string().max(64).default("weekly-ops"), rows: z.number().int().min(0).max(1_000_000).default(1000) }).strict(),
  "webhook.simulate": z.object({ ...base, event: z.string().max(64).default("order.created") }).strict(),
} as const;

export type JobType = keyof typeof JOB_TYPE_SCHEMAS;
export const JOB_TYPES = Object.keys(JOB_TYPE_SCHEMAS) as JobType[];
export type SimPayload = { failureProbability: number; durationMs: number } & Record<string, unknown>;

export interface SimulationResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

const ERRORS: Record<JobType, string[]> = {
  "email.send": ["SMTP 421 service not available (simulated)", "recipient mailbox throttled (simulated)"],
  "image.resize": ["decoder: corrupt JPEG segment (simulated)", "worker OOM while resizing (simulated)"],
  "report.generate": ["query timeout after 30s (simulated)", "upstream warehouse unavailable (simulated)"],
  "webhook.simulate": ["endpoint returned 503 (simulated)", "TLS handshake timeout (simulated)"],
};

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic given rng + sleep: sleeps durationMs, fails with probability failureProbability. */
export async function simulateJob(type: JobType, payload: SimPayload, rng: () => number = Math.random, sleep: Sleep = realSleep): Promise<SimulationResult> {
  const duration = Math.min(2000, Math.max(0, Math.round(payload.durationMs * (0.75 + rng() * 0.5))));
  await sleep(duration);
  const fail = rng() < payload.failureProbability;
  if (!fail) return { ok: true, durationMs: duration };
  const msgs = ERRORS[type];
  return { ok: false, durationMs: duration, error: msgs[Math.floor(rng() * msgs.length) % msgs.length] };
}
