import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql, type SQL } from "drizzle-orm";
import type { Exec } from "@/lib/db/repo";

/** Real Postgres (PGlite/WASM) with the production migrations applied. */
export async function testDb() {
  const pg = new PGlite();
  const db = drizzle(pg);
  await migrate(db, { migrationsFolder: "./drizzle" });
  const exec: Exec = async (q: SQL) => ((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;
  const makeDue = () => exec(sql`update jobs set next_attempt_at = now() - interval '1 second' where status = 'failed'`);
  return { pg, exec, makeDue };
}
export const noSleep = async () => {};
export const seq = (...vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
