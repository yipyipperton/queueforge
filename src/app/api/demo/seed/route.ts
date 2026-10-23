import { z } from "zod";
import { createJobSchema } from "@/lib/core/schemas";
import { sampleJobs } from "@/lib/core/samples";
import { insertJob } from "@/lib/db/repo";
import { demoRateLimit, handleError, json, readJson, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";
const body = z.object({ count: z.number().int().min(1).max(12).default(8) }).strict();

/** Public demo: create a capped batch of sample jobs. Rate limited per IP (DB-backed). */
export async function POST(req: Request) {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try {
    const limited = await demoRateLimit(exec, req, "demo.seed", 10); if (limited) return limited;
    const { count } = body.parse((await readJson(req)) ?? {});
    const jobs = [];
    for (const s of sampleJobs(count)) jobs.push((await insertJob(exec, createJobSchema.parse(s))).job);
    return json({ created: jobs.length, jobs }, 201);
  } catch (e) { return handleError(e); }
}
