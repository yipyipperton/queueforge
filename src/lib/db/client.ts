import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { SQL } from "drizzle-orm";
import type { Exec } from "./repo";

let cached: Exec | null | undefined;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Returns a query executor, or null when DATABASE_URL is not configured. */
export function getExec(): Exec | null {
  if (cached !== undefined) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) return (cached = null);
  const db = drizzle(neon(url));
  cached = async (q: SQL) => {
    const res = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    return res.rows;
  };
  return cached;
}
