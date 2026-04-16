/**
 * Model registry — unified interface for multiple prediction backends.
 *
 * Each backend must implement:
 *   { name: string,
 *     load(dir): Promise<LoadedBundle>,
 *     predict(bundle, x, opts?): { [target]: {p10,p50,p90} },
 *     meta(bundle): { trees?:number, params?:number, ... } }
 *
 * The registry discovers which model types are available in a
 * directory (by probing for sub-directory manifests) and provides a
 * single `loadAllModels` / `selectBestModel` surface for the
 * Predictor to consume.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ── backend store ────────────────────────────────────────────────

const backends = new Map();

/** Register a prediction backend (gbdt, mlp, linear, ...). */
export function registerBackend(name, backend) {
  backends.set(name, backend);
}

/** Retrieve a registered backend by name. */
export function getBackend(name) {
  return backends.get(name);
}

/** List all registered backend names. */
export function listBackends() {
  return [...backends.keys()];
}

// ── discovery ────────────────────────────────────────────────────

/**
 * Auto-detect which models are available in a directory.
 *
 * Checks for `manifest.json` in each known sub-directory
 * (`gbdt/`, `mlp/`, `linear/`) and in the root itself (legacy
 * flat GBDT layout written by the original training script).
 *
 * @param {string} baseDir
 * @returns {Promise<Array<{type:string, dir:string, manifest:Object}>>}
 */
export async function detectModels(baseDir) {
  const found = [];

  // Subdirectory-per-type layout: baseDir/<type>/manifest.json
  for (const type of backends.keys()) {
    const dir = path.join(baseDir, type);
    const manifestPath = path.join(dir, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        found.push({ type, dir, manifest });
      } catch (_) {
        // Corrupt manifest — skip this type.
      }
    }
  }

  // Legacy flat layout: baseDir/manifest.json (assume GBDT unless the
  // manifest explicitly declares a different model_type).
  const rootManifest = path.join(baseDir, "manifest.json");
  if (existsSync(rootManifest)) {
    try {
      const manifest = JSON.parse(await readFile(rootManifest, "utf-8"));
      const type = manifest.model_type ?? "gbdt";
      // Avoid double-counting if the same type was already found above.
      if (!found.some((f) => f.type === type && f.dir === baseDir)) {
        found.push({ type, dir: baseDir, manifest });
      }
    } catch (_) {
      // Corrupt root manifest — skip.
    }
  }

  return found;
}

// ── loading ──────────────────────────────────────────────────────

/**
 * Load all available models from a directory.
 *
 * Probes for every registered backend, loads whichever ones are
 * present, and returns them keyed by backend name.
 *
 * @param {string} baseDir
 * @returns {Promise<Map<string, Object>>}  Map<type, loadedBundle>
 */
export async function loadAllModels(baseDir) {
  const detected = await detectModels(baseDir);
  const loaded = new Map();

  for (const { type, dir } of detected) {
    const backend = backends.get(type);
    if (!backend) continue;
    try {
      const model = await backend.load(dir);
      if (model) loaded.set(type, model);
    } catch (_) {
      // Backend failed to load — skip rather than abort everything.
    }
  }

  return loaded;
}

// ── selection ────────────────────────────────────────────────────

/**
 * Select the best model based on test metrics stored in manifests.
 *
 * Compares `cost.log_rmse` (lower is better) across all loaded
 * models. Falls back to the first available model if no metrics
 * are present.
 *
 * @param {Map<string, Object>} models  from loadAllModels
 * @returns {{type:string, model:Object}|null}
 */
export function selectBestModel(models) {
  if (models.size === 0) return null;

  let bestType = null;
  let bestModel = null;
  let bestScore = Infinity;

  for (const [type, model] of models) {
    const manifest = model.manifest ?? {};
    const metrics = manifest.metrics ?? manifest.test_metrics ?? {};
    // Prefer the cost target's log_rmse; fall back to overall log_rmse.
    const rmse = metrics.cost?.log_rmse ?? metrics.log_rmse ?? Infinity;
    if (rmse < bestScore) {
      bestScore = rmse;
      bestType = type;
      bestModel = model;
    }
  }

  // If no model had metrics, just pick the first one in insertion order.
  if (bestModel === null) {
    const [firstType, firstModel] = models.entries().next().value;
    return { type: firstType, model: firstModel };
  }

  return { type: bestType, model: bestModel };
}
