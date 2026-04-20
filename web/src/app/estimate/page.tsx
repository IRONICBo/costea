"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface SimilarTask {
  prompt: string; source: string; model: string; tokens: number; input: number; output: number;
  cache_read: number; cost_usd: number; tool_calls: number; tools: string[]; similarity: number; reasoning_pct: number;
}
interface Provider { name: string; cost: number }
interface Interval { p10: number; p50: number; p90: number }
interface EstimateResult {
  task: string; task_type: string; has_history: boolean;
  similar_tasks: SimilarTask[];
  estimate: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_hit_pct: number; tool_calls: number; est_runtime: string };
  providers: Provider[];
  total_cost: number; best_provider: string; confidence: number;
  ml_method?: string;
  ml_intervals?: { input: Interval; output: Interval; cache_read: Interval; tools: Interval; cost: Interval };
  stats: { total_sessions: number; total_historical_tasks: number; avg_tokens_per_task: number; avg_cost_per_task: number; models_used: string[]; top_tools: string[]; avg_cache_hit_pct: number };
}

function fmt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Small method pill — turns the ml_method string into a readable badge */
function MethodBadge({ method }: { method?: string }) {
  if (!method) return <span className="pill">heuristic</span>;
  const isMl = /gbdt|mlp|linear|ensemble/i.test(method);
  return (
    <span className={`pill ${isMl ? "pill-brand" : ""}`}>
      {isMl ? "ML · " : ""}{method}
    </span>
  );
}

/** Conformal p10 — p50 — p90 visual for each dimension */
function IntervalRow({ label, interval, format }: { label: string; interval: Interval; format: (n: number) => string }) {
  const range = Math.max(interval.p90 - interval.p10, 0.0001);
  const midPct = ((interval.p50 - interval.p10) / range) * 100;
  return (
    <div className="text-xs">
      <div className="flex justify-between mb-1">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-[11px]">
          <span className="text-muted-light">{format(interval.p10)}</span>
          <span className="mx-1">·</span>
          <span className="font-semibold">{format(interval.p50)}</span>
          <span className="mx-1">·</span>
          <span className="text-muted-light">{format(interval.p90)}</span>
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-warm overflow-hidden">
        <div
          className="absolute top-0 bottom-0 rounded-full"
          style={{
            left: `0%`,
            right: `0%`,
            background: "linear-gradient(90deg, rgba(107,93,255,0.35), rgba(255,138,92,0.45), rgba(45,190,168,0.35))",
          }}
        />
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-foreground"
          style={{ left: `calc(${midPct}% - 1px)` }}
        />
      </div>
    </div>
  );
}

function ReceiptPreview({ data }: { data: EstimateResult }) {
  const e = data.estimate;
  return (
    <div className="bg-surface receipt-shadow rounded max-w-[340px] w-full font-receipt text-sm">
      <div className="h-3 bg-[repeating-linear-gradient(90deg,transparent,transparent_4px,var(--surface)_4px,var(--surface)_8px)] rounded-t" />
      <div className="px-5 pt-5 pb-4 text-center">
        <p className="text-base font-bold tracking-[0.3em]">COSTEA</p>
        <p className="text-[9px] text-muted mt-0.5 tracking-[0.2em] uppercase">Agent Cost Receipt</p>
        <p className="text-[9px] text-muted-light mt-0.5">{new Date().toISOString().slice(0, 19).replace("T", " ")}</p>

        <div className="receipt-dash my-3" />
        <div className="text-left">
          <p className="text-[9px] text-muted uppercase tracking-wider">Task</p>
          <p className="text-[11px] text-foreground mt-0.5 leading-snug">{data.task.slice(0, 60)}</p>
          <p className="text-[9px] text-muted-light mt-0.5">Type: {data.task_type}</p>
        </div>

        <div className="receipt-dash my-3" />
        <div className="space-y-1 text-[10px]">
          {([
            ["Input tokens", fmt(e.input_tokens)],
            ["Output tokens", fmt(e.output_tokens)],
            ["Cache read", fmt(e.cache_read_tokens)],
            ["Cache hit rate", `${e.cache_hit_pct}%`],
            ["Tool calls", String(e.tool_calls)],
            ["Similar tasks", String(data.similar_tasks.length)],
            ["Est. runtime", e.est_runtime],
          ] as [string, string][]).map(([l, v]) => (
            <div key={l} className="flex justify-between"><span className="text-muted">{l}</span><span className="text-foreground">{v}</span></div>
          ))}
        </div>

        <div className="receipt-dash my-3" />
        <p className="text-[9px] text-muted uppercase tracking-wider text-left mb-1.5">Provider Estimates</p>
        <div className="space-y-0.5 text-[10px]">
          {data.providers.map(p => (
            <div key={p.name} className="flex justify-between">
              <span className={p.name === data.best_provider ? "text-foreground font-medium" : "text-foreground/70"}>{p.name}</span>
              <span className="text-foreground">{fmtCost(p.cost)}</span>
            </div>
          ))}
        </div>

        <div className="receipt-double my-3" />
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] font-bold uppercase tracking-wider">Estimated Total</span>
          <span className="text-lg font-bold">{fmtCost(data.total_cost)}</span>
        </div>
        <p className="text-[9px] text-muted-light text-right">best price: {data.best_provider}</p>

        <div className="receipt-dash my-3" />
        <div className="flex justify-between text-[10px]">
          <span className="text-muted">Confidence</span>
          <span className="font-bold">{data.confidence}%</span>
        </div>
        {data.ml_method && (
          <p className="text-[8px] text-muted-light mt-1">via {data.ml_method}</p>
        )}

        <div className="receipt-dash my-3" />
        <div className="bg-surface-warm -mx-5 px-5 py-2">
          <p className="text-[11px]">Proceed? <span className="font-bold">[Y/N]</span><span className="inline-block w-[5px] h-[11px] bg-foreground animate-pulse align-middle ml-1" /></p>
        </div>
        <p className="text-[8px] text-muted-light mt-3 tracking-wide">POWERED BY /COSTEA SKILL</p>
        <div className="flex justify-center gap-[2px] mt-2">
          {[3,1,2,1,3,2,1,1,3,1,2,3,1,2,1,1,3,2,1,3].map((w, i) => (
            <div key={i} className="bg-foreground" style={{ width: `${w}px`, height: "14px" }} />
          ))}
        </div>
      </div>
      <div className="h-3 bg-[repeating-linear-gradient(90deg,transparent,transparent_4px,var(--surface)_4px,var(--surface)_8px)] rounded-b" />
    </div>
  );
}

function EstimateInner() {
  const searchParams = useSearchParams();
  const initial = searchParams.get("task") ?? "";
  const [task, setTask] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);

  const doEstimate = async (value?: string) => {
    const t = (value ?? task).trim();
    if (!t) return;
    setTask(t);
    setLoading(true);
    try {
      const r = await fetch(`/api/estimate?task=${encodeURIComponent(t)}`);
      setResult(await r.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initial) void doEstimate(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="mb-10">
        <p className="eyebrow mb-2">Estimate</p>
        <h1 className="text-4xl font-semibold tracking-tight">What will this task cost?</h1>
        <p className="text-sm text-muted mt-2 max-w-xl">
          Describe the agent task in plain language. Costea runs it through
          the ensemble (GBDT + MLP + Linear) and returns tokens, tools,
          runtime, and a per-provider price — with an honest confidence
          interval.
        </p>
      </div>

      {/* Input */}
      <div className="card p-4 md:p-5 mb-10 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-70"
             style={{ backgroundImage: "radial-gradient(ellipse 40% 60% at 0% 0%, rgba(107,93,255,0.08), transparent 60%)" }} />
        <div className="relative flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doEstimate()}
            placeholder="e.g. refactor the auth module to use cookie-based sessions"
            className="flex-1 px-4 py-3 bg-surface-elevated border border-border-soft rounded-[var(--radius-md)] text-sm focus:outline-none focus:border-foreground/40 transition-colors"
          />
          <button
            onClick={() => doEstimate()}
            disabled={loading || !task.trim()}
            className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Estimating…" : "Estimate →"}
          </button>
        </div>
      </div>

      {loading && !result && (
        <div className="card p-10 text-center">
          <p className="text-muted text-sm">Running ensemble prediction…</p>
        </div>
      )}

      {result && (
        <>
          {/* Top summary row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
            <div className="stat-tile">
              <p className="stat-tile-label">Best total</p>
              <p className="stat-tile-value">{fmtCost(result.total_cost)}</p>
              <p className="text-[11px] text-muted mt-1">{result.best_provider}</p>
            </div>
            <div className="stat-tile">
              <p className="stat-tile-label">Input</p>
              <p className="stat-tile-value">{fmt(result.estimate.input_tokens)}</p>
              <p className="text-[11px] text-muted mt-1">tokens</p>
            </div>
            <div className="stat-tile">
              <p className="stat-tile-label">Output</p>
              <p className="stat-tile-value">{fmt(result.estimate.output_tokens)}</p>
              <p className="text-[11px] text-muted mt-1">tokens</p>
            </div>
            <div className="stat-tile">
              <p className="stat-tile-label">Tools</p>
              <p className="stat-tile-value">{result.estimate.tool_calls}</p>
              <p className="text-[11px] text-muted mt-1">est. calls</p>
            </div>
            <div className="stat-tile">
              <p className="stat-tile-label">Confidence</p>
              <p className="stat-tile-value">{result.confidence}%</p>
              <div className="mt-2"><MethodBadge method={result.ml_method} /></div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-8 mb-10">
            {/* Receipt */}
            <div className="flex justify-center lg:justify-start">
              <ReceiptPreview data={result} />
            </div>

            {/* Right column: intervals + providers */}
            <div className="space-y-6">
              {result.ml_intervals && (
                <div className="card p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="eyebrow">80% prediction intervals</p>
                      <p className="text-xs text-muted mt-1">p10 · <span className="font-semibold">p50</span> · p90 — conformally calibrated</p>
                    </div>
                    <MethodBadge method={result.ml_method} />
                  </div>
                  <div className="space-y-4">
                    <IntervalRow label="Cost" interval={result.ml_intervals.cost} format={fmtCost} />
                    <IntervalRow label="Input tokens" interval={result.ml_intervals.input} format={(n) => fmt(Math.round(n))} />
                    <IntervalRow label="Output tokens" interval={result.ml_intervals.output} format={(n) => fmt(Math.round(n))} />
                    <IntervalRow label="Cache read" interval={result.ml_intervals.cache_read} format={(n) => fmt(Math.round(n))} />
                    <IntervalRow label="Tool calls" interval={result.ml_intervals.tools} format={(n) => String(Math.round(n))} />
                  </div>
                </div>
              )}

              {/* Providers */}
              <div className="card p-6">
                <p className="eyebrow mb-4">Provider comparison</p>
                <div className="space-y-2">
                  {result.providers.map((p) => {
                    const max = Math.max(...result.providers.map((pp) => pp.cost));
                    const pct = max > 0 ? (p.cost / max) * 100 : 0;
                    const isBest = p.name === result.best_provider;
                    return (
                      <div key={p.name} className="flex items-center gap-3">
                        <span className={`text-xs w-44 truncate ${isBest ? "font-semibold" : "text-foreground-soft"}`}>
                          {p.name}
                          {isBest && <span className="pill pill-positive ml-2 text-[9px]">best</span>}
                        </span>
                        <div className="flex-1 h-2 bg-surface-warm rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              background: isBest
                                ? "linear-gradient(90deg, var(--brand-a), var(--brand-b))"
                                : "var(--foreground)",
                              opacity: isBest ? 1 : 0.35,
                            }}
                          />
                        </div>
                        <span className="font-mono text-xs w-16 text-right">{fmtCost(p.cost)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
            {/* Similar tasks */}
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <p className="eyebrow">Nearest historical tasks</p>
                <span className="pill">{result.similar_tasks.length} matches</span>
              </div>
              {result.similar_tasks.length === 0 ? (
                <p className="text-xs text-muted">
                  No similar tasks found — falling back to baseline estimates for &quot;{result.task_type}&quot;.
                </p>
              ) : (
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-2">
                  {result.similar_tasks.map((t, i) => (
                    <div key={i} className="border-b border-border-soft last:border-0 pb-3 last:pb-0">
                      <div className="flex justify-between items-start gap-2">
                        <p className="text-xs text-foreground-soft truncate">{t.prompt}</p>
                        <span className="pill pill-brand shrink-0 text-[9px]">{Math.round(t.similarity)}% match</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px] text-muted">
                        <span>{fmt(t.tokens)} tok</span>
                        <span>{fmtCost(t.cost_usd)}</span>
                        <span>{t.tool_calls} tools</span>
                        {t.reasoning_pct > 0 && <span>{t.reasoning_pct}% reasoning</span>}
                        <span className="text-muted-light ml-auto">{t.source}</span>
                      </div>
                      {t.tools.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {t.tools.slice(0, 6).map((name) => (
                            <span key={name} className="text-[9px] bg-surface-warm px-1.5 py-0.5 rounded font-mono">{name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Confidence explainer */}
            <div className="card p-6 relative overflow-hidden">
              <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full blur-3xl"
                   style={{ background: result.confidence >= 85
                     ? "radial-gradient(circle, rgba(45,190,168,0.25), transparent 70%)"
                     : result.confidence >= 60
                     ? "radial-gradient(circle, rgba(255,215,107,0.25), transparent 70%)"
                     : "radial-gradient(circle, rgba(255,138,92,0.25), transparent 70%)" }} />
              <p className="eyebrow mb-3">Confidence — {result.confidence}%</p>
              <div className="relative w-full bg-surface-warm rounded-full h-3 overflow-hidden mb-3">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{
                    width: `${result.confidence}%`,
                    background: "linear-gradient(90deg, var(--brand-a), var(--brand-b), var(--brand-c))",
                  }}
                />
              </div>
              <p className="text-sm text-foreground-soft leading-relaxed">
                {result.confidence >= 85
                  ? "High — strong match with historical data. Estimate is reliable within the 80% band."
                  : result.confidence >= 60
                    ? "Medium — some similar tasks found, but limited data. Expect wider realized variance."
                    : "Low — no strong matches. Using baseline heuristics. Actual cost could deviate significantly."}
              </p>

              <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted">Sessions indexed</p>
                  <p className="font-semibold font-mono">{fmt(result.stats.total_sessions)}</p>
                </div>
                <div>
                  <p className="text-muted">Historical tasks</p>
                  <p className="font-semibold font-mono">{fmt(result.stats.total_historical_tasks)}</p>
                </div>
                <div>
                  <p className="text-muted">Avg tokens/task</p>
                  <p className="font-semibold font-mono">{fmt(result.stats.avg_tokens_per_task)}</p>
                </div>
                <div>
                  <p className="text-muted">Avg cost/session</p>
                  <p className="font-semibold font-mono">{fmtCost(result.stats.avg_cost_per_task)}</p>
                </div>
              </div>

              {result.stats.models_used.length > 0 && (
                <div className="mt-4">
                  <p className="text-[10px] text-muted mb-1">Models observed</p>
                  <div className="flex flex-wrap gap-1">
                    {result.stats.models_used.map((m) => (
                      <span key={m} className="pill">{m}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function EstimatePage() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto px-6 py-12"><p className="text-muted">Loading…</p></div>}>
      <EstimateInner />
    </Suspense>
  );
}
