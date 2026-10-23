export const JOB_STATUSES = ["queued", "processing", "completed", "failed", "dead_lettered"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Allowed state transitions. `failed` means "attempt failed, waiting for retry at next_attempt_at".
 * Terminal: completed. dead_lettered is terminal unless an operator manually re-queues it.
 */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["processing"],
  processing: ["completed", "failed", "dead_lettered", "queued"], // queued = released (budget exhausted / lease expired)
  failed: ["processing"],
  completed: [],
  dead_lettered: ["queued"], // manual retry
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(public from: JobStatus, public to: JobStatus) {
    super(`Invalid job state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const CLAIMABLE_STATUSES: readonly JobStatus[] = ["queued", "failed"];
export const isTerminal = (s: JobStatus) => TRANSITIONS[s].length === 0;
