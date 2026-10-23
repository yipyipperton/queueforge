import { processBatch } from "@/lib/core/worker";
import { demoRateLimit, handleError, json, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Public demo: a small bounded worker pass (limit 10, 8s budget). Rate limited per IP. */
export async function POST(req: Request) {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try {
    const limited = await demoRateLimit(exec, req, "demo.process", 20); if (limited) return limited;
    return json(await processBatch(exec, { limit: 10, budgetMs: 8000 }));
  } catch (e) { return handleError(e); }
}
