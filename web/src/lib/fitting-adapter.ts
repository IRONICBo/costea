/**
 * Adapter that bridges the @costea/fitting ML prediction module into
 * the Web UI's estimate API.
 *
 * Tries to load the Predictor; returns null if models are unavailable
 * so the caller can fall back to the heuristic estimator.
 */

import path from "path";

const FITTING_DIR = path.resolve(process.cwd(), "..", "fitting");

/** Multi-provider prices (USD per million tokens) */
const PROVIDERS = [
  { name: "Claude Sonnet 4.6", input: 3, output: 15, cache_read: 0.30 },
  { name: "Claude Opus 4.6", input: 5, output: 25, cache_read: 0.50 },
  { name: "Claude Haiku 4.5", input: 1, output: 5, cache_read: 0.10 },
  { name: "GPT-5.4", input: 2.5, output: 15, cache_read: 0 },
  { name: "GPT-5.2 Codex", input: 1.07, output: 8.5, cache_read: 0 },
  { name: "Gemini 2.5 Pro", input: 1.25, output: 5, cache_read: 0 },
  { name: "Gemini 2.5 Flash", input: 0.15, output: 0.6, cache_read: 0 },
];

function priceCost(prov: { input: number; output: number; cache_read: number }, tokens: { input: number; output: number; cache_read: number }) {
  return (tokens.input * prov.input + tokens.output * prov.output + tokens.cache_read * prov.cache_read) / 1_000_000;
}

interface Predictor {
  predict: (taskDesc: string, opts: { source: string }) => FittingResult;
}

interface FittingResult {
  ok: boolean;
  method: string;
  confidence: number;
  input: { p10: number; p50: number; p90: number };
  output: { p10: number; p50: number; p90: number };
  cache_read: { p10: number; p50: number; p90: number };
  tools: { p10: number; p50: number; p90: number };
  cost: { p10: number; p50: number; p90: number };
  neighbours: Array<{
    score: number;
    prompt: string;
    skill_name: string | null;
    source: string;
    actual: { input: number; output: number; cache_read: number; tools: number; cost: number };
  }>;
}

/**
 * Try to predict using the fitting module. Returns null if not available.
 */
export async function predictWithFitting(taskDesc: string): Promise<null | Record<string, unknown>> {
  let Predictor: { fitFromIndex: () => Promise<Predictor> } | undefined;
  try {
    const target = path.join(FITTING_DIR, "src", "index.mjs");
    const mod = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ target);
    Predictor = mod.Predictor;
  } catch {
    return null;
  }
  if (!Predictor) return null;

  let predictor: Predictor;
  try {
    predictor = await Predictor.fitFromIndex();
  } catch {
    return null;
  }

  const result: FittingResult = predictor.predict(taskDesc, { source: "web-estimate" });
  if (!result.ok) return null;

  // Map to the Web UI's EstimateResult format.
  const estInput = Math.round(result.input.p50);
  const estOutput = Math.round(result.output.p50);
  const estCacheRead = Math.round(result.cache_read.p50);
  const estTools = Math.round(result.tools.p50);
  const estTotalTokens = estInput + estOutput + estCacheRead;
  const estSeconds = Math.max(10, Math.round(estTotalTokens / 1200));
  const estRuntime = estSeconds < 60 ? `~${estSeconds}s` : `~${Math.round(estSeconds / 60)} min`;

  const tokens = { input: estInput, output: estOutput, cache_read: estCacheRead };
  const providers = PROVIDERS.map((p) => ({ name: p.name, cost: Math.round(priceCost(p, tokens) * 10000) / 10000 }))
    .sort((a, b) => a.cost - b.cost);

  const totalCost = providers.find((p) => p.name.includes("Sonnet"))?.cost ?? providers[0].cost;

  return {
    task: taskDesc,
    task_type: result.method,
    has_history: result.neighbours.length > 0,
    similar_tasks: result.neighbours.slice(0, 5).map((n) => ({
      prompt: n.prompt,
      source: n.source,
      model: "",
      tokens: (n.actual.input || 0) + (n.actual.output || 0) + (n.actual.cache_read || 0),
      input: n.actual.input || 0,
      output: n.actual.output || 0,
      cache_read: n.actual.cache_read || 0,
      cost_usd: n.actual.cost || 0,
      tool_calls: n.actual.tools || 0,
      tools: [],
      similarity: n.score,
      reasoning_pct: 0,
    })),
    estimate: {
      input_tokens: estInput,
      output_tokens: estOutput,
      cache_read_tokens: estCacheRead,
      cache_hit_pct: estTotalTokens > 0 ? Math.round((estCacheRead / estTotalTokens) * 100) : 0,
      tool_calls: estTools,
      est_runtime: estRuntime,
    },
    providers: providers.slice(0, 5),
    total_cost: totalCost,
    best_provider: providers[0].name,
    confidence: result.confidence,
    ml_method: result.method,
    ml_intervals: {
      input: result.input,
      output: result.output,
      cache_read: result.cache_read,
      tools: result.tools,
      cost: result.cost,
    },
    stats: {
      total_sessions: 0,
      total_historical_tasks: 0,
      avg_tokens_per_task: 0,
      avg_cost_per_task: 0,
      models_used: [],
      top_tools: [],
      avg_cache_hit_pct: 0,
    },
  };
}
