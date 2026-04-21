"use client";

import { useEffect, useState } from "react";

interface Stats {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
  sources: { source: string; count: number }[];
  byModel: Record<string, { tokens: number; cost: number; sessions: number }>;
  byDay: { date: string; cost: number; tokens: number; sessions: number }[];
}

function fmt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) { return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`; }

/** Simple inline bar chart (no external deps) */
function HBar({ items }: { items: { label: string; value: number; display: string }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-0.5">
            <span className="truncate max-w-[200px]">{item.label}</span>
            <span className="font-mono text-muted shrink-0 ml-2">{item.display}</span>
          </div>
          <div className="w-full bg-surface-warm rounded-full h-2.5 overflow-hidden">
            <div
              className="h-2.5 rounded-full transition-all"
              style={{
                width: `${(item.value / max) * 100}%`,
                background: "linear-gradient(90deg, var(--brand-a), var(--brand-b))",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Sparkline-style cost-by-day chart using SVG */
function CostTimeline({ data }: { data: { date: string; cost: number }[] }) {
  if (data.length === 0) return <p className="text-xs text-muted">No data</p>;

  const W = 600, H = 160, P = 30;
  const maxCost = Math.max(...data.map((d) => d.cost), 0.01);
  const points = data.map((d, i) => ({
    x: P + (i / Math.max(data.length - 1, 1)) * (W - 2 * P),
    y: H - P - (d.cost / maxCost) * (H - 2 * P),
    ...d,
  }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${points.at(-1)!.x},${H - P} L${points[0].x},${H - P} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = H - P - pct * (H - 2 * P);
        return (
          <g key={pct}>
            <line x1={P} y1={y} x2={W - P} y2={y} stroke="var(--border)" strokeWidth="0.5" />
            <text x={P - 4} y={y + 3} textAnchor="end" fontSize="8" fill="var(--muted)">
              {fmtCost(maxCost * pct)}
            </text>
          </g>
        );
      })}
      {/* Gradient defs */}
      <defs>
        <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand-a)" stopOpacity="0.35" />
          <stop offset="50%" stopColor="var(--brand-b)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--brand-c)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="costLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--brand-a)" />
          <stop offset="50%" stopColor="var(--brand-b)" />
          <stop offset="100%" stopColor="var(--brand-c)" />
        </linearGradient>
      </defs>
      {/* Area */}
      <path d={areaPath} fill="url(#costGrad)" />
      {/* Line */}
      <path d={linePath} fill="none" stroke="url(#costLine)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="var(--foreground)" />
      ))}
      {/* X labels (show every Nth) */}
      {points
        .filter((_, i) => i % Math.max(1, Math.floor(points.length / 8)) === 0)
        .map((p) => (
          <text key={p.date} x={p.x} y={H - 8} textAnchor="middle" fontSize="7" fill="var(--muted)">
            {p.date.slice(5)}
          </text>
        ))}
    </svg>
  );
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="max-w-4xl mx-auto px-6 py-16"><p className="text-muted">Error: {error}</p></div>;
  if (!stats) return <div className="max-w-4xl mx-auto px-6 py-16"><p className="text-muted">Loading analytics...</p></div>;

  const modelItems = Object.entries(stats.byModel)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, d]) => ({ label: model, value: d.cost, display: fmtCost(d.cost) }));

  const sourceItems = stats.sources
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ label: s.source, value: s.count, display: `${s.count} sessions` }));

  const tokensByModel = Object.entries(stats.byModel)
    .sort(([, a], [, b]) => b.tokens - a.tokens)
    .map(([model, d]) => ({ label: model, value: d.tokens, display: fmt(d.tokens) }));

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-8">
        <p className="eyebrow mb-2">Analytics</p>
        <h1 className="text-4xl font-semibold tracking-tight">Spending over time</h1>
        <p className="text-sm text-muted mt-2">
          {fmt(stats.sessionCount)} sessions · {fmt(stats.totalTokens)} tokens · {fmtCost(stats.totalCost)}
        </p>
      </div>

      {/* Cost over time */}
      <div className="card p-6 mb-8 relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full blur-3xl opacity-60"
             style={{ background: "radial-gradient(circle, rgba(107,93,255,0.22), transparent 70%)" }} />
        <div className="relative">
          <p className="eyebrow mb-4">Cost over time</p>
          <CostTimeline data={stats.byDay} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by model */}
        <div className="card p-6">
          <p className="eyebrow mb-4">Cost by model</p>
          {modelItems.length > 0 ? <HBar items={modelItems} /> : <p className="text-xs text-muted">No model data</p>}
        </div>

        {/* Tokens by model */}
        <div className="card p-6">
          <p className="eyebrow mb-4">Tokens by model</p>
          {tokensByModel.length > 0 ? <HBar items={tokensByModel} /> : <p className="text-xs text-muted">No data</p>}
        </div>

        {/* By platform */}
        <div className="card p-6">
          <p className="eyebrow mb-4">Sessions by platform</p>
          <HBar items={sourceItems} />
        </div>

        {/* Daily breakdown table */}
        <div className="card p-6">
          <p className="eyebrow mb-4">Daily breakdown · last 14 days</p>
          <div className="overflow-y-auto max-h-[300px]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="text-left pb-2">Date</th>
                  <th className="text-right pb-2">Sessions</th>
                  <th className="text-right pb-2">Tokens</th>
                  <th className="text-right pb-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.byDay.slice(-14).reverse().map((d) => (
                  <tr key={d.date} className="border-b border-border/30">
                    <td className="py-1.5 font-mono">{d.date}</td>
                    <td className="py-1.5 text-right">{d.sessions}</td>
                    <td className="py-1.5 text-right font-mono">{fmt(d.tokens)}</td>
                    <td className="py-1.5 text-right font-mono font-medium">{fmtCost(d.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
