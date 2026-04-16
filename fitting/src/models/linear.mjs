/**
 * Pure-JS linear model inference.
 *
 * The simplest prediction backend: a single dot product plus
 * intercept per (target, quantile) head. Useful as a baseline
 * and as a fast fallback when heavier models are unavailable.
 *
 * Weights JSON shape (written by the Python trainer):
 *
 *   { coef: number[], intercept: number }
 *
 * Bundle layout mirrors the GBDT and MLP patterns:
 *
 *   linear/
 *     manifest.json
 *     weights_cost_p10.json
 *     weights_cost_p50.json
 *     ...
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ── inference ────────────────────────────────────────────────────

/**
 * Predict a scalar value: y = coef · x + intercept.
 *
 * @param {ArrayLike<number>} x
 * @param {{coef:number[], intercept:number}} weights
 * @returns {number}
 */
export function linearPredict(x, weights) {
  let sum = weights.intercept;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * weights.coef[i];
  }
  return sum;
}

// ── loading ──────────────────────────────────────────────────────

/**
 * Load linear weights from a single JSON file.
 *
 * @param {string} filePath
 * @returns {Promise<{coef:number[], intercept:number}>}
 */
export async function loadLinearWeights(filePath) {
  const text = await readFile(filePath, "utf-8");
  return JSON.parse(text);
}

/**
 * Load all linear quantile heads from a directory.
 *
 * Expected layout:
 *
 *   linear/
 *     manifest.json
 *     weights_cost_p10.json
 *     weights_cost_p50.json
 *     weights_cost_p90.json
 *     weights_input_p10.json
 *     ...
 *
 * @param {string} dir
 * @returns {Promise<{manifest:Object, heads:Object<string,{p10:Object,p50:Object,p90:Object}>, dir:string}|null>}
 */
export async function loadLinearBundle(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  const heads = {};

  for (const [tgt, qmap] of Object.entries(manifest.files || {})) {
    heads[tgt] = {};
    for (const [qname, fname] of Object.entries(qmap)) {
      const file = path.join(dir, fname);
      if (!existsSync(file)) {
        throw new Error(`linear bundle ${dir}: manifest references missing weights ${fname}`);
      }
      heads[tgt][qname] = await loadLinearWeights(file);
    }
  }

  return { manifest, heads, dir };
}

// ── bundle prediction ────────────────────────────────────────────

/**
 * Predict all targets using a loaded linear bundle.
 *
 * Same interface as `predictBundle` (gbdt.mjs) and
 * `predictMLPBundle` (mlp.mjs): returns
 * `{ [target]: { p10, p50, p90 } }` in raw units.
 *
 * Models are trained in log1p space; back-transform with expm1
 * unless the caller asks for raw log-space values. Quantile
 * crossings are forced monotone (p10 <= p50 <= p90).
 *
 * @param {Object} bundle   from loadLinearBundle
 * @param {ArrayLike<number>} x  feature vector
 * @param {{expm1?:boolean}} opts
 * @returns {Object<string, {p10:number, p50:number, p90:number}>}
 */
export function predictLinearBundle(bundle, x, { expm1: doExpm1 = true } = {}) {
  const out = {};
  for (const [tgt, heads] of Object.entries(bundle.heads)) {
    const p10 = linearPredict(x, heads.p10);
    const p50 = linearPredict(x, heads.p50);
    const p90 = linearPredict(x, heads.p90);

    const back = doExpm1 ? Math.expm1 : (z) => z;

    // Force monotone p10 <= p50 <= p90 in case quantile crossings happened.
    let lo = Math.min(p10, p50, p90);
    let hi = Math.max(p10, p50, p90);
    let mid = p10 + p50 + p90 - lo - hi;

    out[tgt] = {
      p10: Math.max(0, back(lo)),
      p50: Math.max(0, back(mid)),
      p90: Math.max(0, back(hi)),
    };
  }
  return out;
}
