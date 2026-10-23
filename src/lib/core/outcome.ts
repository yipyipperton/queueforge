import { backoffDelay, BackoffConfig, DEFAULT_BACKOFF } from "./backoff";
import { assertTransition, JobStatus } from "./states";

export interface OutcomeInput {
  attempts: number; // attempts made INCLUDING the one that just finished
  maxRetries: number; // retries allowed after the first attempt => total attempts = maxRetries + 1
  success: boolean;
}

export type Outcome =
  | { status: "completed"; nextAttemptAt: null }
  | { status: "failed"; nextAttemptAt: Date; delayMs: number }
  | { status: "dead_lettered"; nextAttemptAt: null };

export function decideOutcome(
  input: OutcomeInput,
  now: Date = new Date(),
  cfg: BackoffConfig = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): Outcome {
  let result: Outcome;
  if (input.success) result = { status: "completed", nextAttemptAt: null };
  else if (input.attempts >= input.maxRetries + 1) result = { status: "dead_lettered", nextAttemptAt: null };
  else {
    const delayMs = backoffDelay(input.attempts, cfg, rng);
    result = { status: "failed", nextAttemptAt: new Date(now.getTime() + delayMs), delayMs };
  }
  assertTransition("processing" as JobStatus, result.status);
  return result;
}
