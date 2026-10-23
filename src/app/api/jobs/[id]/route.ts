import { uuidSchema } from "@/lib/core/schemas";
import { getJob } from "@/lib/db/repo";
import { err, handleError, json, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) return err(400, "invalid_id", "Job id must be a UUID.");
  try {
    const r = await getJob(exec, id);
    return r ? json(r) : err(404, "not_found", "Job not found.");
  } catch (e) { return handleError(e); }
}
