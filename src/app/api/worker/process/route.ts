import { processSchema } from "@/lib/core/schemas";
import { processBatch } from "@/lib/core/worker";
import { handleError, json, readJson, requireAdmin, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Admin/cron: one bounded worker pass. */
export async function POST(req: Request) {
  const denied = requireAdmin(req); if (denied) return denied;
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try {
    const opts = processSchema.parse((await readJson(req)) ?? {});
    return json(await processBatch(exec, opts));
  } catch (e) { return handleError(e); }
}
