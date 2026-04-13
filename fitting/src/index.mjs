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
import { encodeQuery } from "./features/encoder.mjs";
import { predictBundle } from "./models/gbdt.mjs";
import { loadBundle, defaultModelsDir } from "./models/bundle.mjs";

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
  constructor({ vectorizer, index, calibrators, providers, costFn, builtAt, sizes, bundle }) {
    this.vectorizer = vectorizer;
    this.index = index;
    this.calibrators = calibrators;
    this.providers = providers ?? PROVIDERS;
    this.costFn = costFn ?? defaultCostFn;
    this.builtAt = builtAt ?? new Date().toISOString();
    this.sizes = sizes ?? {};
    /** Optional boosted-tree bundle. When present, drives the primary path. */
    this.bundle = bundle ?? null;
  }

  /**
   * Fit a Predictor from the canonical ~/.costea/task-index.json.
   *
   * Train on the first 80%, calibrate on the next 10%, leave the
   * final 10% untouched for evaluation. If you want to ship a
   * production model trained on everything, pass {evalSplit:false}.
   *
   * Also tries to attach a GBDT bundle. By default that's the
   * bundled demo at fitting/models/. Pass `modelsDir` to point at a
   * user-trained directory; pass `loadBundle:false` to skip entirely.
   */
  static async fitFromIndex(opts = {}) {
    const split = await loadSplit({ indexPath: opts.indexPath });
    const bundle = await maybeLoadBundle(opts);
    return Predictor.fitFromTasks({
      train: split.train,
      val: split.val,
      builtAt: split.built_at,
      bundle,
      ...opts,
    });
  }

  /** Like fitFromIndex but uses every usable task as both train + val. */
  static async fitFromIndexAll(opts = {}) {
    const idx = await loadIndex(opts.indexPath);
    const all = annotateSequence(filterUsable(idx.tasks));
    // Hold out a small slice for calibration so isotonic still has signal.
    const cut = Math.floor(all.length * 0.9);
    const bundle = await maybeLoadBundle(opts);
    return Predictor.fitFromTasks({
      train: all.slice(0, cut),
      val: all.slice(cut),
      builtAt: idx.built_at,
      bundle,
      ...opts,
    });
  }

  static fitFromTasks({ train, val, builtAt, costFn, providers, k = 10, bundle = null } = {}) {
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
      bundle,
      sizes: {
        train: train.length,
        val: val ? val.length : 0,
        vocab: vec.stats().vocab_size,
        gbdt_trees: bundle
          ? Object.values(bundle.heads).reduce(
              (s, h) => s + h.p10.trees.length + h.p50.trees.length + h.p90.trees.length, 0)
          : 0,
      },
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
    // Always run kNN — it provides explainability evidence even when
    // the boosted-tree bundle is the actual source of the numbers.
    const neighbours = this.index.search(qVec, qMeta, { k, asOf: opts.asOf ?? new Date() });

    let primary, method, confidence;
    if (this.bundle) {
      // Boosted-tree path: encode the query into the manifest's
      // feature schema and walk every quantile head.
      const x = encodeQuery(prompt, opts, this.bundle.manifest);
      primary = predictBundle(this.bundle, x);
      method = "gbdt_quantile";
      // Confidence uses the kNN top-3 as a soft proxy: closer
      // neighbours → we trust the GBDT extrapolation more.
      const top3 = neighbours.slice(0, 3);
      const avg = top3.length
        ? top3.reduce((s, n) => s + Math.max(0, n.score), 0) / top3.length
        : 0;
      confidence = Math.round(55 + Math.min(1, avg) * 40);
    } else {
      // Fallback: empirical quantiles from the kNN hits.
      const raw = empiricalPredict(neighbours);
      if (!raw.ok) {
        return { ok: false, reason: raw.reason, features, neighbours: [], confidence: 0 };
      }
      primary = raw.predictions;
      method = "tfidf_knn_empirical";
      confidence = raw.confidence;
    }

    // Apply isotonic+conformal calibrators target-by-target. They
    // were fit against the empirical predictor; on the GBDT path the
    // log-space monotonicity assumption still holds, so the same
    // calibration is a reasonable default.
    const calibrated = {};
    for (const tgt of TARGETS) {
      const c = this.calibrators[tgt];
      calibrated[tgt] = c ? applyIntervalCalibrator(c, primary[tgt]) : primary[tgt];
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
      method: this.calibrators && Object.keys(this.calibrators).length > 0
        ? `${method}_calibrated`
        : method,
      confidence,
      features,
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

/**
 * Internal: load the GBDT bundle if requested. Returns null when
 * the user explicitly opted out OR when the directory is missing.
 */
async function maybeLoadBundle(opts) {
  if (opts.bundle) return opts.bundle; // caller passed pre-loaded
  if (opts.loadBundle === false) return null;
  const dir = opts.modelsDir ?? defaultModelsDir();
  try {
    return await loadBundle(dir);
  } catch (e) {
    // A broken bundle should be loud — surface it rather than silently
    // falling back to kNN with mysteriously different numbers.
    if (opts.modelsDir) throw e;
    return null;
  }
}

export { loadSplit, loadIndex, filterUsable, annotateSequence, timeSplit };
