"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface Point { t: string; ok: number; failed: number; p50: number; p95: number }
const fmt = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const axis = { stroke: "#4b5260", fontSize: 10, tickLine: false, axisLine: false } as const;
const tip = {
  contentStyle: { background: "#0e1014", border: "1px solid #1f232b", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-geist-mono)" },
  labelStyle: { color: "#8a909c" }, cursor: { fill: "rgba(255,255,255,0.03)" }, labelFormatter: (l: unknown) => fmt(String(l)),
};

function Empty() {
  return <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">no attempts in the last 60 min</div>;
}

export function ThroughputChart({ data }: { data: Point[] }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke="#1a1d23" />
        <XAxis dataKey="t" tickFormatter={fmt} {...axis} minTickGap={24} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip {...tip} />
        <Bar dataKey="ok" name="succeeded" stackId="a" fill="#2f6fde" isAnimationActive={false} />
        <Bar dataKey="failed" name="failed" stackId="a" fill="#b45360" radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LatencyChart({ data }: { data: Point[] }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="p95" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f6fde" stopOpacity={0.25} /><stop offset="100%" stopColor="#2f6fde" stopOpacity={0} /></linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="#1a1d23" />
        <XAxis dataKey="t" tickFormatter={fmt} {...axis} minTickGap={24} />
        <YAxis unit="ms" {...axis} />
        <Tooltip {...tip} formatter={(v) => `${v} ms`} />
        <Area type="monotone" dataKey="p95" name="p95" stroke="#2f6fde" fill="url(#p95)" strokeWidth={1.5} isAnimationActive={false} />
        <Area type="monotone" dataKey="p50" name="p50" stroke="#8a909c" fill="transparent" strokeWidth={1.25} strokeDasharray="3 3" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
