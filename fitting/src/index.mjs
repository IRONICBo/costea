/**
 * Public API for @costea/fitting.
 *
 * Exposes the `Predictor` — a single object that holds the fitted
 * vectorizer, kNN index, calibrators, and provider price table.
 * `fit()` builds it from the historical task index; `predict()` runs
 * one query end-to-end.
 *
 * Designed so a downstream caller (Web UI, CLI skill) can do:
 *
 *   import { Predictor } from "@costea/fitting";
 *   const p = await Predictor.fitFromIndex();
 *   const r = p.predict("refactor auth middleware", { source: "claude-code" });
 *   //  r.cost.p50, r.cost.p10, r.cost.p90, r.confidence, r.neighbours[]
 */

import { loadSplit, loadIndex, filterUsable, annotateSequence, timeSplit } from "./data/loader.mjs";
import { TfidfVectorizer } from "./retrieval/embed.mjs";
import { KnnIndex } from "./retrieval/knn.mjs";
import { empiricalPredict, attachTargets } from "./models/empirical.mjs";
import { fitIntervalCalibrator, applyIntervalCalibrator } from "./models/calibration.mjs";
import { extractQueryFeatures } from "./features/extract.mjs";

/** Default per-million-token prices. Mirrors web/src/lib/estimator.ts. */
export const PROVIDERS = [
  { name: "Claude Sonnet 4.6",  input: 3,    output: 15,   cache_read: 0.30 },
  { name: "Claude Opus 4.6",    input: 5,    output: 25,   cache_read: 0.50 },
  { name: "Claude Haiku 4.5",   input: 1,    output: 5,    cache_read: 0.10 },
  { name: "GPT-5.4",            input: 2.5,  output: 15,   cache_read: 0    },
  { name: "GPT-5.2 Codex",      input: 1.07, output: 8.5,  cache_read: 0    },
  { name: "Gemini 2.5 Pro",     input: 1.25, output: 5,    cache_read: 0    },
  { name: "Gemini 2.5 Flash",   input: 0.15, output: 0.6,  cache_read: 0    },
];

const TARGETS = ["input", "output", "cache_read", "tools", "cost"];

function priceCost(p, t) {
  return ((t.input || 0) * p.input
        + (t.output || 0) * p.output
        + (t.cache_read || 0) * p.cache_read) / 1_000_000;
}
function defaultCostFn(task) {
  // Use Sonnet 4.6 as the canonical "what one task cost in USD".
  return priceCost(PROVIDERS[0], {
    input: task.token_usage.input,
    output: task.token_usage.output,
    cache_read: task.token_usage.cache_read,
  });
}

export class Predictor {
  constructor({ vectorizer, index, calibrators, providers, costFn, builtAt, sizes }) {
    this.vectorizer = vectorizer;
    this.index = index;
    this.calibrators = calibrators;
    this.providers = providers ?? PROVIDERS;
    this.costFn = costFn ?? defaultCostFn;
    this.builtAt = builtAt ?? new Date().toISOString();
    this.sizes = sizes ?? {};
  }

  /**
   * Fit a Predictor from the canonical ~/.costea/task-index.json.
   *
   * Train on the first 80%, calibrate on the next 10%, leave the
   * final 10% untouched for evaluation. If you want to ship a
   * production model trained on everything, pass {evalSplit:false}.
   */
  static async fitFromIndex(opts = {}) {
    const split = await loadSplit({ indexPath: opts.indexPath });
    return Predictor.fitFromTasks({
      train: split.train,
      val: split.val,
      builtAt: split.built_at,
      ...opts,
    });
  }

  /** Like fitFromIndex but uses every usable task as both train + val. */
  static async fitFromIndexAll(opts = {}) {
    const idx = await loadIndex(opts.indexPath);
    const all = annotateSequence(filterUsable(idx.tasks));
    // Hold out a small slice for calibration so isotonic still has signal.
    const cut = Math.floor(all.length * 0.9);
    return Predictor.fitFromTasks({
      train: all.slice(0, cut),
      val: all.slice(cut),
      builtAt: idx.built_at,
      ...opts,
    });
  }

  static fitFromTasks({ train, val, builtAt, costFn, providers, k = 10 } = {}) {
    if (!train || train.length === 0) throw new Error("Predictor.fit: empty train set");
    const vec = new TfidfVectorizer().fit(train.map((t) => t.user_prompt));
    const cf = costFn ?? defaultCostFn;
    const vecs = train.map((t) => vec.transform(t.user_prompt));
    const metas = train.map((t) => attachTargets(
      { skill_name: t.skill_name, source: t.source, model: t.model,
        timestamp: t.timestamp, prompt: (t.user_prompt || "").slice(0, 120),
        session_id: t.session_id },
      t, cf
    ));
    const index = new KnnIndex(vecs, metas);

    // Fit calibrators on val if we have enough samples.
    const calibrators = {};
    if (val && val.length >= 30) {
      const valPredsByTarget = Object.fromEntries(TARGETS.map((t) => [t, { preds: [], acts: [] }]));
      for (const t of val) {
        const qVec = vec.transform(t.user_prompt);
        const qMeta = { skill_name: t.skill_name, source: t.source };
        const neigh = index.search(qVec, qMeta, { k, asOf: new Date(t.timestamp) });
        const r = empiricalPredict(neigh);
        if (!r.ok) continue;
        for (const tgt of TARGETS) {
          const a = tgt === "cost" ? cf(t) :
                    tgt === "tools" ? (t.total_tool_calls || 0) :
                    (t.token_usage[tgt] || 0);
          valPredsByTarget[tgt].preds.push(r.predictions[tgt]);
          valPredsByTarget[tgt].acts.push(a);
        }
      }
      for (const tgt of TARGETS) {
        const { preds, acts } = valPredsByTarget[tgt];
        if (preds.length >= 20) calibrators[tgt] = fitIntervalCalibrator(preds, acts);
      }
    }

    return new Predictor({
      vectorizer: vec,
      index,
      calibrators,
      providers: providers ?? PROVIDERS,
      costFn: cf,
      builtAt,
      sizes: { train: train.length, val: val ? val.length : 0, vocab: vec.stats().vocab_size },
    });
  }

  /**
   * One-shot prediction.
   *
   * @param {string} prompt
   * @param {{source?:string, model?:string, k?:number,
   *          turn_index?:number, prior_session_total?:number,
   *          asOf?:Date}} opts
   */
  predict(prompt, opts = {}) {
    const k = opts.k ?? 10;
    const qVec = this.vectorizer.transform(prompt);
    const features = extractQueryFeatures(prompt, opts);
    const qMeta = {
      skill_name: features.skill_name,
      source: opts.source ?? null,
    };
    const neighbours = this.index.search(qVec, qMeta, { k, asOf: opts.asOf ?? new Date() });
    const raw = empiricalPredict(neighbours);

    if (!raw.ok) {
      return {
        ok: false,
        reason: raw.reason,
        features,
        neighbours: [],
        confidence: 0,
      };
    }

    // Apply calibrators target-by-target.
    const calibrated = {};
    for (const tgt of TARGETS) {
      const c = this.calibrators[tgt];
      calibrated[tgt] = c
        ? applyIntervalCalibrator(c, raw.predictions[tgt])
        : raw.predictions[tgt];
    }

    // Cross-provider cost, using calibrated input/output/cache_read P50.
    const tokens = {
      input: Math.max(0, calibrated.input.p50),
      output: Math.max(0, calibrated.output.p50),
      cache_read: Math.max(0, calibrated.cache_read.p50),
    };
    const providerCosts = this.providers
      .map((p) => ({ name: p.name, cost: priceCost(p, tokens) }))
      .sort((a, b) => a.cost - b.cost);

    return {
      ok: true,
      method: "tfidf_knn_empirical_calibrated",
      confidence: raw.confidence,
      features,
      // Per-target intervals, in raw units.
      input: calibrated.input,
      output: calibrated.output,
      cache_read: calibrated.cache_read,
      tools: calibrated.tools,
      cost: calibrated.cost,
      providers: providerCosts,
      best_provider: providerCosts[0],
      // Top neighbours, lightly redacted, for explainability.
      neighbours: neighbours.map((n) => ({
        score: Math.round(n.score * 1000) / 1000,
        sim: Math.round(n.sim * 1000) / 1000,
        prompt: n.meta.prompt,
        skill_name: n.meta.skill_name,
        source: n.meta.source,
        timestamp: n.meta.timestamp,
        actual: {
          input: n.meta.y_input,
          output: n.meta.y_output,
          cache_read: n.meta.y_cache_read,
          tools: n.meta.y_tools,
          cost: n.meta.y_cost,
        },
      })),
    };
  }
}

export { loadSplit, loadIndex, filterUsable, annotateSequence, timeSplit };
