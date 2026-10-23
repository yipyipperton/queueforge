import { createJobSchema, listJobsQuery } from "@/lib/core/schemas";
import { insertJob, listJobs } from "@/lib/db/repo";
import { err, handleError, json, readJson, requireAdmin, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try {
    const q = listJobsQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    const jobs = await listJobs(exec, q);
    return json({ jobs, nextCursor: jobs.length === q.limit ? jobs[jobs.length - 1].createdAt : null });
  } catch (e) { return handleError(e); }
}

export async function POST(req: Request) {
  const denied = requireAdmin(req); if (denied) return denied;
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try {
    const body = await readJson(req);
    if (body === undefined) return err(400, "invalid_json", "Body must be valid JSON.");
    const input = createJobSchema.parse(body);
    const { job, created } = await insertJob(exec, input);
    return json({ job, created }, created ? 201 : 200);
  } catch (e) { return handleError(e); }
}
