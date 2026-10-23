import { z } from "zod";
import { JOB_TYPE_SCHEMAS, JOB_TYPES, JobType } from "./jobTypes";
import { JOB_STATUSES } from "./states";

export const createJobSchema = z
  .object({
    type: z.enum(JOB_TYPES as [JobType, ...JobType[]]),
    payload: z.record(z.string(), z.unknown()).default({}),
    maxRetries: z.number().int().min(0).max(10).default(3),
    idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  })
  .strict()
  .transform((v, ctx) => {
    const parsed = JOB_TYPE_SCHEMAS[v.type].safeParse(v.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["payload", ...issue.path] } as never);
      return z.NEVER;
    }
    return { ...v, payload: parsed.data as Record<string, unknown> & { failureProbability: number; durationMs: number } };
  });
export type CreateJobInput = z.output<typeof createJobSchema>;

export const listJobsQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES as [JobType, ...JobType[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

export const processSchema = z.object({
  limit: z.number().int().min(1).max(25).default(10),
  budgetMs: z.number().int().min(500).max(20_000).default(8000),
}).strict();

export const uuidSchema = z.string().uuid();
