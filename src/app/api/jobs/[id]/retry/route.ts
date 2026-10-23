import { uuidSchema } from "@/lib/core/schemas";
import { getJob, retryDeadLetter } from "@/lib/db/repo";
import { err, handleError, json, requireAdmin, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Admin: re-queue a dead-lettered job. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req); if (denied) return denied;
  const exec = requireDb(); if (exec instanceof Response) return exec;
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) return err(400, "invalid_id", "Job id must be a UUID.");
  try {
    const job = await retryDeadLetter(exec, id);
    if (job) return json({ job });
    const existing = await getJob(exec, id);
    return existing ? err(409, "invalid_state", `Job is ${existing.job.status}; only dead_lettered jobs can be retried.`) : err(404, "not_found", "Job not found.");
  } catch (e) { return handleError(e); }
}
