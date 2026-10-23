import { cn } from "@/lib/utils";
const STYLES: Record<string, string> = {
  queued: "text-zinc-300 bg-zinc-500/10 ring-zinc-500/25",
  processing: "text-sky-300 bg-sky-500/10 ring-sky-500/30",
  completed: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/25",
  failed: "text-amber-300 bg-amber-500/10 ring-amber-500/25",
  dead_lettered: "text-rose-300 bg-rose-500/10 ring-rose-500/25",
};
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10.5px] ring-1 ring-inset", STYLES[status] ?? STYLES.queued, className)}>
      <span className={cn("size-1.5 rounded-full bg-current", status === "processing" && "animate-pulse")} />
      {status === "failed" ? "retrying" : status.replace("_", "-")}
    </span>
  );
}
