import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { getExec } from "../db/client";
import type { Exec } from "../db/repo";
import { rateLimit } from "../db/repo";

export const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

export const err = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  json({ error: { code, message, ...extra } }, status);

export const dbNotConfigured = () =>
  err(503, "database_not_configured", "DATABASE_URL is not set. Connect a Neon Postgres database and run migrations (see README).");

export function requireDb(): Exec | Response {
  return getExec() ?? dbNotConfigured();
}

/** Bearer ADMIN_TOKEN check (constant-time). If ADMIN_TOKEN is unset, admin endpoints are disabled entirely. */
export function requireAdmin(req: Request): Response | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return err(503, "admin_not_configured", "ADMIN_TOKEN is not set on the server; admin endpoints are disabled.");
  const h = req.headers.get("authorization") ?? "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return err(401, "unauthorized", "Missing or invalid bearer token.");
  return null;
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

export async function demoRateLimit(exec: Exec, req: Request, route: string, max: number, windowSec = 60): Promise<Response | null> {
  const r = await rateLimit(exec, `${route}:${clientIp(req)}`, max, windowSec);
  if (r.allowed) return null;
  return json({ error: { code: "rate_limited", message: `Demo limit reached (${max}/${windowSec}s per IP).`, resetAt: r.resetAt } }, 429, {
    "retry-after": String(Math.max(1, Math.ceil((new Date(r.resetAt).getTime() - Date.now()) / 1000))),
  });
}

export async function readJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return undefined; }
}

export function handleError(e: unknown): Response {
  if (e instanceof ZodError) return err(400, "validation_error", "Request validation failed.", { issues: e.issues });
  console.error(e);
  return err(500, "internal_error", "Unexpected server error.");
}
