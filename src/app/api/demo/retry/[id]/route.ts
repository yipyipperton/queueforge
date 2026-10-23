import { uuidSchema } from "@/lib/core/schemas";
import { retryDeadLetter } from "@/lib/db/repo";
import { demoRateLimit, err, handleError, json, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Public demo: manual DLQ retry. Rate limited per IP. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) return err(400, "invalid_id", "Job id must be a UUID.");
  try {
    const limited = await demoRateLimit(exec, req, "demo.retry", 30); if (limited) return limited;
    const job = await retryDeadLetter(exec, id);
    return job ? json({ job }) : err(409, "invalid_state", "Job not found or not dead_lettered.");
  } catch (e) { return handleError(e); }
}
