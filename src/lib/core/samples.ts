import type { CreateJobInput } from "./schemas";
import { JOB_TYPES } from "./jobTypes";

/** Generates a varied batch of sample jobs (inputs, still validated by createJobSchema). */
export function sampleJobs(n: number, rng: () => number = Math.random) {
  return Array.from({ length: n }, (_, i) => {
    const type = JOB_TYPES[Math.floor(rng() * JOB_TYPES.length) % JOB_TYPES.length];
    const roll = rng();
    const failureProbability = roll < 0.15 ? 1 : roll < 0.5 ? 0.5 : roll < 0.8 ? 0.15 : 0;
    return {
      type,
      payload: { failureProbability, durationMs: 80 + Math.floor(rng() * 700) },
      maxRetries: i % 4 === 0 ? 1 : 3,
    } as unknown as CreateJobInput;
  });
}
