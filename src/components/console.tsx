"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Boxes, Copy, Database, Play, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { LatencyChart, ThroughputChart, type Point } from "@/components/charts";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/db/repo";

type Metrics = { counts: Record<string, number>; attempts24h: { ok: number; failed: number; successRate: number | null; p50: number; p95: number }; series: Point[] };
type Detail = { job: Job; events: { from: string | null; to: string; reason: string | null; at: string }[]; attempts: { attempt: number; outcome: string; error: string | null; startedAt: string; finishedAt: string; durationMs: number }[] };
const FILTERS = ["all", "queued", "processing", "failed", "completed", "dead_lettered"] as const;
type Filter = (typeof FILTERS)[number];

const shortId = (id: string) => id.slice(0, 8);
function ago(iso: string | null) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < -1) return `in ${fmtDur(-s)}`;
  return s < 2 ? "now" : `${fmtDur(s)} ago`;
}
function fmtDur(s: number) { return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; }
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "." + String(new Date(iso).getMilliseconds()).padStart(3, "0");

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
  return body as T;
}

export function Console({ dbConfigured }: { dbConfigured: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<"jobs" | "dlq">("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dlq, setDlq] = useState<Job[]>([]);
  const [m, setM] = useState<Metrics | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [live, setLive] = useState(true);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!dbConfigured) return;
    try {
      const q = filter === "all" ? "" : `&status=${filter}`;
      const [j, d, mm] = await Promise.all([
        api<{ jobs: Job[] }>(`/api/jobs?limit=100${q}`),
        api<{ jobs: Job[] }>(`/api/jobs?limit=100&status=dead_lettered`),
        api<Metrics>(`/api/metrics`),
      ]);
      setJobs(j.jobs); setDlq(d.jobs); setM(mm); setLastPoll(Date.now()); setPollError(null);
    } catch (e) { setPollError((e as Error).message); }
  }, [filter, dbConfigured]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!live || !dbConfigured) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2500);
    return () => clearInterval(t);
  }, [live, refresh, dbConfigured]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let stop = false;
    const load = () => api<Detail>(`/api/jobs/${selected}`).then((d) => !stop && setDetail(d)).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [selected]);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); } }, [toast]);

  async function action(name: string, fn: () => Promise<string>) {
    setBusy(name);
    try { setToast({ kind: "ok", msg: await fn() }); await refresh(); }
    catch (e) { setToast({ kind: "err", msg: (e as Error).message }); }
    finally { setBusy(null); }
  }
  const seed = () => action("seed", async () => { const r = await api<{ created: number }>("/api/demo/seed", { method: "POST", body: JSON.stringify({ count: 8 }) }); return `Enqueued ${r.created} sample jobs`; });
  const process = () => action("process", async () => {
    const r = await api<{ claimed: number; completed: number; failed: number; deadLettered: number; released: number; elapsedMs: number }>("/api/demo/process", { method: "POST", body: "{}" });
    return r.claimed ? `Worker pass: ${r.claimed} claimed · ${r.completed} ok · ${r.failed} retry · ${r.deadLettered} DLQ · ${r.elapsedMs}ms` : "Worker pass: nothing due";
  });
  const retry = (id: string) => action(`retry:${id}`, async () => { await api(`/api/demo/retry/${id}`, { method: "POST", body: "{}" }); return `Re-queued ${shortId(id)}`; });

  const c = m?.counts ?? {};
  const sr = m?.attempts24h.successRate;
  const rows = tab === "jobs" ? jobs : dlq;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-4 px-5">
          <div className="flex items-center gap-2">
            <div className="grid size-6 place-items-center rounded bg-primary/15 ring-1 ring-primary/40"><Boxes className="size-3.5 text-primary" /></div>
            <span className="text-sm font-semibold tracking-tight">QueueForge</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">/ console</span>
          </div>
          <div className="ml-2 hidden items-center gap-3 font-mono text-[10.5px] text-muted-foreground md:flex">
            <span className="flex items-center gap-1.5"><Database className="size-3" />{dbConfigured ? (pollError ? <span className="text-amber-300">db error</span> : <span className="text-emerald-300/90">postgres · connected</span>) : <span className="text-amber-300">database not configured</span>}</span>
            <span className="text-border">|</span>
            <button onClick={() => setLive((v) => !v)} className="flex items-center gap-1.5 hover:text-foreground" disabled={!dbConfigured}>
              <span className={cn("size-1.5 rounded-full", live && dbConfigured ? "animate-pulse bg-primary" : "bg-zinc-600")} />{live ? "live · 2.5s" : "paused"}
            </button>
            {lastPoll && <span className="tabular">synced {new Date(lastPoll).toLocaleTimeString([], { hour12: false })}</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={seed} disabled={!dbConfigured || !!busy}><Sparkles />{busy === "seed" ? "Enqueuing…" : "Create sample jobs"}</Button>
            <Button size="sm" onClick={process} disabled={!dbConfigured || !!busy}><Play />{busy === "process" ? "Processing…" : "Process jobs"}</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 px-5 py-5">
        {!dbConfigured && (
          <Card className="border-amber-500/30 bg-amber-500/[0.04]">
            <CardContent className="flex gap-3 py-3.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
              <div className="space-y-1 text-[13px]">
                <div className="font-medium text-amber-200">Database not configured</div>
                <p className="text-muted-foreground">This deployment has no <code className="font-mono text-foreground">DATABASE_URL</code>. QueueForge stores every job, transition, attempt and rate-limit counter in Postgres and never falls back to in-memory storage, so the console is read-only and empty. Connect a Neon Postgres database (Vercel → Storage → Neon), run <code className="font-mono text-foreground">npm run db:migrate</code>, and redeploy.</p>
              </div>
            </CardContent>
          </Card>
        )}

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Metric label="Active" value={c.active} sub={`${c.queued ?? 0} queued · ${c.processing ?? 0} running · ${c.retrying ?? 0} retrying`} />
          <Metric label="Completed" value={c.completed} sub={`${c.total ?? 0} total jobs`} />
          <Metric label="Failed attempts · 24h" value={m?.attempts24h.failed} sub={`${m?.attempts24h.ok ?? 0} succeeded`} tone={m?.attempts24h.failed ? "warn" : undefined} />
          <Metric label="Success rate · 24h" value={sr == null ? undefined : `${(sr * 100).toFixed(1)}%`} sub={`p50 ${Math.round(m?.attempts24h.p50 ?? 0)}ms · p95 ${Math.round(m?.attempts24h.p95 ?? 0)}ms`} />
          <Metric label="Dead-lettered" value={c.dead_lettered} sub="awaiting operator" tone={c.dead_lettered ? "bad" : undefined} />
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>Throughput · attempts / min</CardTitle><Legend items={[["#2f6fde", "succeeded"], ["#b45360", "failed"]]} /></CardHeader><CardContent className="h-44 pt-3"><ThroughputChart data={m?.series ?? []} /></CardContent></Card>
          <Card><CardHeader><CardTitle>Execution latency</CardTitle><Legend items={[["#2f6fde", "p95"], ["#8a909c", "p50"]]} /></CardHeader><CardContent className="h-44 pt-3"><LatencyChart data={m?.series ?? []} /></CardContent></Card>
        </section>

        <Card>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
            <TabBtn active={tab === "jobs"} onClick={() => setTab("jobs")}><Activity className="size-3" />Jobs</TabBtn>
            <TabBtn active={tab === "dlq"} onClick={() => setTab("dlq")}><AlertTriangle className="size-3" />Dead-letter queue{dlq.length > 0 && <span className="ml-1 rounded bg-rose-500/15 px-1 font-mono text-[10px] text-rose-300">{dlq.length}</span>}</TabBtn>
            {tab === "jobs" && (
              <div className="ml-auto flex flex-wrap gap-0.5">
                {FILTERS.map((f) => (
                  <button key={f} onClick={() => setFilter(f)} className={cn("rounded px-2 py-1 font-mono text-[10.5px] transition-colors", filter === f ? "bg-accent text-foreground ring-1 ring-inset ring-border" : "text-muted-foreground hover:text-foreground")}>
                    {f === "failed" ? "retrying" : f.replace("_", "-")}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                  {["Job ID", "Type", "Status", "Attempts", "Last error", tab === "dlq" ? "Dead since" : "Next attempt", "Created", ""].map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => {
                  const fresh = !seen.current.has(j.id + j.status);
                  seen.current.add(j.id + j.status);
                  return (
                    <tr key={j.id} onClick={() => setSelected(j.id)} className={cn("cursor-pointer border-t border-border/70 transition-colors hover:bg-white/[0.025]", fresh && lastPoll && "row-new", selected === j.id && "bg-primary/[0.06]")}>
                      <td className="px-3 py-1.5 font-mono text-[11.5px] text-sky-200/90">{shortId(j.id)}</td>
                      <td className="px-3 py-1.5 font-mono text-[11.5px]">{j.type}</td>
                      <td className="px-3 py-1.5"><StatusBadge status={j.status} /></td>
                      <td className="tabular px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground"><span className="text-foreground">{j.attempts}</span>/{j.maxRetries + 1}</td>
                      <td className="max-w-[280px] truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground" title={j.lastError ?? ""}>{j.lastError ?? "—"}</td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{tab === "dlq" ? ago(j.updatedAt) : j.status === "failed" || j.status === "queued" ? ago(j.nextAttemptAt) : "—"}</td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{ago(j.createdAt)}</td>
                      <td className="px-3 py-1 text-right">
                        {j.status === "dead_lettered" && <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); retry(j.id); }} disabled={!!busy}><RotateCcw />Retry</Button>}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-10 text-center font-mono text-[11.5px] text-muted-foreground">
                    {!dbConfigured ? "database not configured — no jobs to show" : tab === "dlq" ? "dead-letter queue is empty" : "no jobs match — click “Create sample jobs”, then “Process jobs”"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <footer className="flex justify-between pb-4 font-mono text-[10.5px] text-muted-foreground">
          <span>Simulated job types only · no user code, no outbound HTTP</span>
          <span>demo actions rate-limited per IP · admin API requires bearer token</span>
        </footer>
      </main>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent>
          <div className="border-b border-border px-5 py-4">
            <SheetTitle className="flex items-center gap-2 font-mono text-sm">{detail?.job.type ?? "…"} {detail && <StatusBadge status={detail.job.status} />}</SheetTitle>
            <SheetDescription className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              {selected}<button onClick={() => selected && navigator.clipboard?.writeText(selected)} className="hover:text-foreground" aria-label="Copy id"><Copy className="size-3" /></button>
            </SheetDescription>
          </div>
          {detail && (
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[12px]">
              <dl className="grid grid-cols-3 gap-x-4 gap-y-2 font-mono text-[11px]">
                {[["attempts", `${detail.job.attempts}/${detail.job.maxRetries + 1}`], ["max retries", detail.job.maxRetries], ["idempotency", detail.job.idempotencyKey ?? "—"], ["created", clock(detail.job.createdAt)], ["next attempt", ["queued", "failed"].includes(detail.job.status) ? ago(detail.job.nextAttemptAt) : "—"], ["completed", detail.job.completedAt ? clock(detail.job.completedAt) : "—"]].map(([k, v]) => (
                  <div key={String(k)}><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt><dd className="truncate">{String(v)}</dd></div>
                ))}
              </dl>
              {detail.job.lastError && <div className="rounded border border-rose-500/20 bg-rose-500/[0.05] px-3 py-2 font-mono text-[11px] text-rose-200">{detail.job.lastError}</div>}
              {detail.job.status === "dead_lettered" && <Button size="sm" onClick={() => retry(detail.job.id)} disabled={!!busy}><RotateCcw />Retry from DLQ</Button>}
              <Section title="Payload"><pre className="overflow-x-auto rounded border border-border bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">{JSON.stringify(detail.job.payload, null, 2)}</pre></Section>
              <Section title={`Attempts (${detail.attempts.length})`}>
                {detail.attempts.length === 0 ? <Muted>not executed yet</Muted> : (
                  <table className="w-full font-mono text-[11px]"><tbody>
                    {detail.attempts.map((a, i) => (
                      <tr key={i} className="border-t border-border/60 first:border-0">
                        <td className="py-1.5 pr-3 text-muted-foreground">#{a.attempt}</td>
                        <td className={cn("py-1.5 pr-3", a.outcome === "success" ? "text-emerald-300" : "text-rose-300")}>{a.outcome}</td>
                        <td className="tabular py-1.5 pr-3">{a.durationMs}ms</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{clock(a.startedAt)}</td>
                        <td className="truncate py-1.5 text-muted-foreground" title={a.error ?? ""}>{a.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </Section>
              <Section title={`State transitions (${detail.events.length})`}>
                <ol className="relative ml-1 space-y-2.5 border-l border-border pl-4">
                  {detail.events.map((e, i) => (
                    <li key={i} className="relative">
                      <span className="absolute -left-[21px] top-1 size-2 rounded-full border border-border bg-card" />
                      <div className="flex items-center gap-1.5 font-mono text-[11px]">
                        {e.from ? <StatusBadge status={e.from} /> : <span className="text-muted-foreground">∅</span>}<span className="text-muted-foreground">→</span><StatusBadge status={e.to} />
                        <span className="ml-auto text-muted-foreground">{clock(e.at)}</span>
                      </div>
                      {e.reason && <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{e.reason}</div>}
                    </li>
                  ))}
                </ol>
              </Section>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {toast && (
        <div className={cn("fixed bottom-4 right-4 z-50 animate-[slide-in_200ms_ease-out] rounded-md border px-3 py-2 font-mono text-[11.5px] shadow-xl", toast.kind === "ok" ? "border-primary/30 bg-[#0f1520] text-sky-100" : "border-rose-500/30 bg-[#1a0f12] text-rose-200")}>{toast.msg}</div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: number | string | undefined; sub?: string; tone?: "warn" | "bad" }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn("tabular mt-1 font-mono text-2xl font-medium tracking-tight", tone === "warn" && "text-amber-200", tone === "bad" && "text-rose-300")}>{value ?? "—"}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{sub}</div>}
    </Card>
  );
}
const Legend = ({ items }: { items: [string, string][] }) => (
  <div className="flex gap-3 font-mono text-[10px] text-muted-foreground">{items.map(([c, l]) => <span key={l} className="flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: c }} />{l}</span>)}</div>
);
const TabBtn = ({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className={cn("flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{children}</button>
);
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section><h4 className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">{title}</h4>{children}</section>
);
const Muted = ({ children }: { children: React.ReactNode }) => <div className="font-mono text-[11px] text-muted-foreground">{children}</div>;
