export interface BackoffConfig {
  baseMs: number;
  capMs: number;
  /** 0..1 fraction of the computed delay that is randomized (0 = deterministic). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: Number(process.env.QF_BACKOFF_BASE_MS ?? 2000),
  capMs: Number(process.env.QF_BACKOFF_CAP_MS ?? 5 * 60_000),
  jitter: 0.5,
};

/** Exponential delay before retry N (attempt = number of attempts already made, >= 1), without jitter. */
export function exponentialDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF): number {
  const a = Math.max(1, Math.floor(attempt));
  // guard against overflow for large attempt counts
  const raw = cfg.baseMs * Math.pow(2, Math.min(a - 1, 30));
  return Math.min(cfg.capMs, raw);
}

/**
 * "Equal jitter": keep (1 - jitter) of the delay fixed and randomize the rest.
 * Result is always within [delay*(1-jitter), delay] and never exceeds capMs.
 */
export function backoffDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF, rng: () => number = Math.random): number {
  const d = exponentialDelay(attempt, cfg);
  const j = Math.min(1, Math.max(0, cfg.jitter));
  const r = Math.min(1, Math.max(0, rng()));
  return Math.round(d * (1 - j) + d * j * r);
}
