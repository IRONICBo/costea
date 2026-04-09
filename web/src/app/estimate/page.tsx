"use client";

import { useState } from "react";

interface SimilarTask {
  prompt: string; source: string; model: string; tokens: number; input: number; output: number;
  cache_read: number; cost_usd: number; tool_calls: number; tools: string[]; similarity: number; reasoning_pct: number;
}
interface Provider { name: string; cost: number }
interface EstimateResult {
  task: string; task_type: string; has_history: boolean;
  similar_tasks: SimilarTask[];
  estimate: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_hit_pct: number; tool_calls: number; est_runtime: string };
  providers: Provider[];
  total_cost: number; best_provider: string; confidence: number;
  stats: { total_sessions: number; total_historical_tasks: number; avg_tokens_per_task: number; avg_cost_per_task: number; models_used: string[]; top_tools: string[]; avg_cache_hit_pct: number };
}

function fmt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) { return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`; }

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
          {([["Input tokens", fmt(e.input_tokens)], ["Output tokens", fmt(e.output_tokens)], ["Cache read", fmt(e.cache_read_tokens)], ["Cache hit rate", `${e.cache_hit_pct}%`], ["Tool calls", String(e.tool_calls)], ["Similar tasks", String(data.similar_tasks.length)], ["Est. runtime", e.est_runtime]] as [string, string][]).map(([l, v]) => (
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

export default function EstimatePage() {
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);

  const doEstimate = async () => {
    if (!task.trim()) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/estimate?task=${encodeURIComponent(task)}`);
      setResult(await r.json());
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Cost Estimate</h1>
      <p className="text-sm text-muted mb-8">Predict token cost before running a task.</p>

      {/* Input */}
      <div className="flex gap-3 mb-10">
        <input
          type="text"
          value={task}
          onChange={e => setTask(e.target.value)}
          onKeyDown={e => e.key === "Enter" && doEstimate()}
          placeholder="Describe your task... e.g. refactor the auth module"
          className="flex-1 px-4 py-3 border border-border rounded bg-surface text-sm focus:outline-none focus:border-foreground transition-colors"
        />
        <button
          onClick={doEstimate}
          disabled={loading || !task.trim()}
          className="px-6 py-3 bg-foreground text-surface rounded text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
        >
          {loading ? "Estimating..." : "Estimate"}
        </button>
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          {/* Left: receipt */}
          <div className="flex justify-center lg:justify-start">
            <ReceiptPreview data={result} />
          </div>

          {/* Right: details */}
          <div className="space-y-6">
            {/* Similar tasks */}
            <div className="bg-surface receipt-shadow rounded p-5">
              <p className="text-xs text-muted uppercase tracking-wider mb-3">
                Similar Tasks ({result.similar_tasks.length})
              </p>
              {result.similar_tasks.length === 0 ? (
                <p className="text-xs text-muted">No similar tasks found — using baseline estimates for &quot;{result.task_type}&quot; tasks.</p>
              ) : (
                <div className="space-y-3 max-h-[400px] overflow-y-auto">
                  {result.similar_tasks.map((t, i) => (
                    <div key={i} className="border-b border-border/30 pb-2 last:border-0">
                      <div className="flex justify-between items-start">
                        <p className="text-xs truncate max-w-[280px]">{t.prompt}</p>
                        <span className="text-[10px] bg-foreground/10 px-1.5 rounded shrink-0 ml-2">{t.similarity}% match</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 mt-1 text-[10px] text-muted">
                        <span>{fmt(t.tokens)} tok</span>
                        <span>{fmtCost(t.cost_usd)}</span>
                        <span>{t.tool_calls} tools</span>
                        <span>{t.reasoning_pct}% reasoning</span>
                        <span className="text-muted-light">{t.source}</span>
                      </div>
                      {t.tools.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {t.tools.map(name => (
                            <span key={name} className="text-[9px] bg-surface-warm px-1 rounded font-mono">{name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Historical stats */}
            <div className="bg-surface receipt-shadow rounded p-5">
              <p className="text-xs text-muted uppercase tracking-wider mb-3">Historical Context</p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><p className="text-muted">Total sessions</p><p className="font-mono font-medium">{fmt(result.stats.total_sessions)}</p></div>
                <div><p className="text-muted">Historical tasks</p><p className="font-mono font-medium">{fmt(result.stats.total_historical_tasks)}</p></div>
                <div><p className="text-muted">Avg tokens/task</p><p className="font-mono font-medium">{fmt(result.stats.avg_tokens_per_task)}</p></div>
                <div><p className="text-muted">Avg cost/session</p><p className="font-mono font-medium">{fmtCost(result.stats.avg_cost_per_task)}</p></div>
                <div><p className="text-muted">Avg cache hit</p><p className="font-mono font-medium">{result.stats.avg_cache_hit_pct}%</p></div>
                <div><p className="text-muted">Task type</p><p className="font-mono font-medium">{result.task_type}</p></div>
              </div>
              {result.stats.models_used.length > 0 && (
                <div className="mt-3">
                  <p className="text-[10px] text-muted mb-1">Models used</p>
                  <div className="flex flex-wrap gap-1">
                    {result.stats.models_used.map(m => (
                      <span key={m} className="text-[9px] bg-surface-warm px-1.5 rounded font-mono">{m}</span>
                    ))}
                  </div>
                </div>
              )}
              {result.stats.top_tools.length > 0 && (
                <div className="mt-3">
                  <p className="text-[10px] text-muted mb-1">Common tools</p>
                  <div className="flex flex-wrap gap-1">
                    {result.stats.top_tools.map(t => (
                      <span key={t} className="text-[9px] bg-surface-warm px-1.5 rounded font-mono">{t}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Confidence explanation */}
            <div className="bg-surface receipt-shadow rounded p-5">
              <p className="text-xs text-muted uppercase tracking-wider mb-3">Confidence: {result.confidence}%</p>
              <div className="w-full bg-surface-warm rounded-full h-3 mb-2">
                <div className="bg-foreground h-3 rounded-full" style={{ width: `${result.confidence}%` }} />
              </div>
              <p className="text-[10px] text-muted">
                {result.confidence >= 85 ? "High — strong match with historical data. Estimate is reliable."
                  : result.confidence >= 60 ? "Medium — some similar tasks found, but limited data. Estimate may vary."
                  : "Low — no strong matches. Using baseline heuristics. Actual cost could differ significantly."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
