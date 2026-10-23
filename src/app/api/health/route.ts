import { sql } from "drizzle-orm";
import { getExec } from "@/lib/db/client";
import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const exec = getExec();
  const base = { adminConfigured: Boolean(process.env.ADMIN_TOKEN) };
  if (!exec) return json({ ok: false, database: "not_configured", ...base }, 503);
  try {
    const [r] = await exec(sql`select to_regclass('public.jobs') is not null as migrated`);
    return json({ ok: Boolean(r.migrated), database: r.migrated ? "connected" : "connected_unmigrated", ...base }, r.migrated ? 200 : 503);
  } catch {
    return json({ ok: false, database: "unreachable", ...base }, 503);
  }
}
