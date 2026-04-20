"use client";

import { useState } from "react";
import Link from "next/link";

interface Provider { name: string; cost: number }
interface Interval { p10: number; p50: number; p90: number }
interface EstimateResult {
  task: string;
  task_type: string;
  estimate: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    tool_calls: number;
    est_runtime: string;
  };
  providers: Provider[];
  total_cost: number;
  best_provider: string;
  confidence: number;
  ml_method?: string;
  ml_intervals?: { cost: Interval };
}

const EXAMPLES = [
  "Refactor the auth module",
  "Add pagination to the sessions API",
  "Fix the flaky login test",
  "Write OpenAPI docs for /estimate",
];

function fmt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) { return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`; }

export function HeroEstimator() {
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (value?: string) => {
    const t = (value ?? task).trim();
    if (!t) return;
    setTask(t);
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/estimate?task=${encodeURIComponent(t)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResult(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass rounded-[var(--radius-xl)] p-5 md:p-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="pill pill-brand">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-b" />
          live estimator
        </span>
        <span className="text-xs text-muted">try it with your own prompt — no signup</span>
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        <input
          type="text"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Describe an agent task… e.g. refactor the auth module"
          className="flex-1 px-4 py-3 bg-surface border border-border-soft rounded-[var(--radius-md)] text-sm placeholder:text-muted-light focus:outline-none focus:border-foreground/40 transition-colors"
        />
        <button
          onClick={() => run()}
          disabled={loading || !task.trim()}
          className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Estimating…" : "Estimate cost →"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            onClick={() => run(e)}
            className="pill hover:border-foreground/40 transition-colors"
          >
            {e}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-xs text-[color:var(--brand-b)]">
          Couldn&apos;t reach the estimator: {error}. Dev server running?
        </p>
      )}

      {result && (
        <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <Tile label="Best total" value={fmtCost(result.total_cost)} hint={result.best_provider} accent />
          <Tile label="Input" value={fmt(result.estimate.input_tokens)} hint="tokens" />
          <Tile label="Output" value={fmt(result.estimate.output_tokens)} hint="tokens" />
          <Tile label="Tools" value={String(result.estimate.tool_calls)} hint="calls" />
          <Tile label="Confidence" value={`${result.confidence}%`} hint={result.ml_method ?? "heuristic"} />

          <div className="col-span-2 md:col-span-5 mt-1 flex flex-wrap items-center gap-2 text-xs">
            {result.providers.slice(0, 4).map((p) => (
              <span key={p.name} className={`pill ${p.name === result.best_provider ? "pill-positive" : ""}`}>
                {p.name}
                <span className="font-mono ml-1">{fmtCost(p.cost)}</span>
              </span>
            ))}
            <Link href={`/estimate?task=${encodeURIComponent(result.task)}`} className="btn-ghost text-xs ml-auto">
              See full receipt →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-md)] p-3 border ${
        accent
          ? "bg-[linear-gradient(135deg,rgba(107,93,255,0.08),rgba(255,138,92,0.06))] border-[rgba(107,93,255,0.25)]"
          : "bg-surface border-border-soft"
      }`}
    >
      <p className="eyebrow text-[9px]">{label}</p>
      <p className="text-lg font-semibold tracking-tight mt-0.5 font-variant-tabular-nums">{value}</p>
      {hint && <p className="text-[10px] text-muted mt-0.5">{hint}</p>}
    </div>
  );
}
