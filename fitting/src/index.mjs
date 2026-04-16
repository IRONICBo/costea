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

import os from "node:os";
import path from "node:path";
import { loadSplit, loadIndex, filterUsable, annotateSequence, timeSplit } from "./data/loader.mjs";
import { TfidfVectorizer } from "./retrieval/embed.mjs";
import { KnnIndex } from "./retrieval/knn.mjs";
import { empiricalPredict, attachTargets } from "./models/empirical.mjs";
import { fitIntervalCalibrator, applyIntervalCalibrator } from "./models/calibration.mjs";
import { extractQueryFeatures } from "./features/extract.mjs";
import { encodeQuery } from "./features/encoder.mjs";
import { predictBundle } from "./models/gbdt.mjs";
import { loadBundle, defaultModelsDir } from "./models/bundle.mjs";
import { loadMLPBundle, predictMLPBundle } from "./models/mlp.mjs";
import { loadLinearBundle, predictLinearBundle } from "./models/linear.mjs";
import { PROVIDERS, priceCost, costFromTask as defaultCostFn } from "./prices.mjs";

export { PROVIDERS };

/** Supported model types for the modelType option. */
export const MODEL_TYPES = ["gbdt", "mlp", "linear", "auto"];

const TARGETS = ["input", "output", "cache_read", "tools", "cost"];

export class Predictor {
  constructor({ vectorizer, index, calibrators, providers, costFn, builtAt, sizes, bundle, mlpBundle, linearBundle, modelType }) {
    this.vectorizer = vectorizer;
    this.index = index;
    this.calibrators = calibrators;
    this.providers = providers ?? PROVIDERS;
    this.costFn = costFn ?? defaultCostFn;
    this.builtAt = builtAt ?? new Date().toISOString();
    this.sizes = sizes ?? {};
    /** GBDT bundle (LightGBM). */
    this.bundle = bundle ?? null;
    /** MLP bundle (PyTorch JSON weights). */
    this.mlpBundle = mlpBundle ?? null;
    /** Linear bundle (ridge/quantile regression). */
    this.linearBundle = linearBundle ?? null;
    /** Active model type: "gbdt" | "mlp" | "linear" | "auto". */
    this.modelType = modelType ?? "auto";
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
    const mlpBundle = await maybeLoadMLPBundle(opts);
    const linearBundle = await maybeLoadLinearBundle(opts);
    return Predictor.fitFromTasks({
      train: split.train,
      val: split.val,
      builtAt: split.built_at,
      bundle,
      mlpBundle,
      linearBundle,
      modelType: opts.modelType ?? "auto",
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

  static fitFromTasks({ train, val, builtAt, costFn, providers, k = 10, bundle = null, mlpBundle = null, linearBundle = null, modelType = "auto" } = {}) {
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
      mlpBundle,
      linearBundle,
      modelType,
      sizes: {
        train: train.length,
        val: val ? val.length : 0,
        vocab: vec.stats().vocab_size,
        gbdt_trees: bundle
          ? Object.values(bundle.heads).reduce(
              (s, h) => s + h.p10.trees.length + h.p50.trees.length + h.p90.trees.length, 0)
          : 0,
        has_mlp: !!mlpBundle,
        has_linear: !!linearBundle,
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

    // Resolve which model backend to use.
    const requestedType = opts.modelType ?? this.modelType;
    const activeType = resolveModelType(requestedType, this);

    if (activeType === "mlp" && this.mlpBundle) {
      const x = encodeQuery(prompt, opts, this.mlpBundle.manifest);
      primary = predictMLPBundle(this.mlpBundle, x);
      method = "mlp_quantile";
    } else if (activeType === "linear" && this.linearBundle) {
      const x = encodeQuery(prompt, opts, this.linearBundle.manifest);
      primary = predictLinearBundle(this.linearBundle, x);
      method = "linear_quantile";
    } else if (this.bundle) {
      const x = encodeQuery(prompt, opts, this.bundle.manifest);
      primary = predictBundle(this.bundle, x);
      method = "gbdt_quantile";
    } else {
      // Ultimate fallback: empirical quantiles from the kNN hits.
      const raw = empiricalPredict(neighbours);
      if (!raw.ok) {
        return { ok: false, reason: raw.reason, features, neighbours: [], confidence: 0 };
      }
      primary = raw.predictions;
      method = "tfidf_knn_empirical";
    }

    // Confidence from kNN top-3 as proxy.
    const top3 = neighbours.slice(0, 3);
    const avg = top3.length
      ? top3.reduce((s, n) => s + Math.max(0, n.score), 0) / top3.length
      : 0;
    if (method === "tfidf_knn_empirical") {
      const raw = empiricalPredict(neighbours);
      confidence = raw.ok ? raw.confidence : 0;
    } else {
      confidence = Math.round(55 + Math.min(1, avg) * 40);
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

/** Path to user-trained models at ~/.costea/models/. */
export function userModelsDir() {
  return path.join(os.homedir(), ".costea", "models");
}

/**
 * Internal: load the GBDT bundle if requested. Returns null when
 * the user explicitly opted out OR when the directory is missing.
 *
 * Priority when `opts.modelsDir` is NOT specified:
 *   1. User-trained model at ~/.costea/models/
 *   2. Bundled demo model at fitting/models/
 *   3. null (pure kNN mode)
 */
async function maybeLoadBundle(opts) {
  if (opts.bundle) return opts.bundle; // caller passed pre-loaded
  if (opts.loadBundle === false) return null;

  // When the caller specifies a directory, honour it strictly.
  if (opts.modelsDir) {
    try {
      return await loadBundle(opts.modelsDir);
    } catch (e) {
      throw e;
    }
  }

  // 1. Try user-trained model first.
  try {
    const userBundle = await loadBundle(userModelsDir());
    if (userBundle) return userBundle;
  } catch (_) {
    // User dir missing or corrupt — fall through to bundled demo.
  }

  // 2. Fall back to bundled demo model.
  try {
    const demoBundle = await loadBundle(defaultModelsDir());
    if (demoBundle) return demoBundle;
  } catch (_) {
    // Demo dir missing or corrupt — pure kNN mode.
  }

  return null;
}

/** Try loading an MLP bundle from ~/.costea/models/mlp/. */
async function maybeLoadMLPBundle(opts) {
  if (opts.mlpBundle) return opts.mlpBundle;
  if (opts.modelType === "gbdt" || opts.modelType === "linear") return null;
  const dir = path.join(userModelsDir(), "mlp");
  try { return await loadMLPBundle(dir); } catch (_) { return null; }
}

/** Try loading a Linear bundle from ~/.costea/models/linear/. */
async function maybeLoadLinearBundle(opts) {
  if (opts.linearBundle) return opts.linearBundle;
  if (opts.modelType === "gbdt" || opts.modelType === "mlp") return null;
  const dir = path.join(userModelsDir(), "linear");
  try { return await loadLinearBundle(dir); } catch (_) { return null; }
}

/**
 * Resolve "auto" model type to the best available backend.
 * Priority: mlp > gbdt > linear > knn (fallback).
 */
function resolveModelType(requested, predictor) {
  if (requested !== "auto") return requested;
  // Auto: prefer MLP if available, then GBDT, then Linear
  if (predictor.mlpBundle) return "mlp";
  if (predictor.bundle) return "gbdt";
  if (predictor.linearBundle) return "linear";
  return "knn";
}

export { loadSplit, loadIndex, filterUsable, annotateSequence, timeSplit };
