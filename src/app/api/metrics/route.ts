import { metrics } from "@/lib/db/repo";
import { handleError, json, requireDb } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const exec = requireDb(); if (exec instanceof Response) return exec;
  try { return json(await metrics(exec)); } catch (e) { return handleError(e); }
}
