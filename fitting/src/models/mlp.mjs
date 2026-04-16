/**
 * Pure-JS MLP (Multi-Layer Perceptron) inference engine.
 *
 * Loads JSON weights exported by the Python trainer and runs
 * forward passes entirely in JavaScript — no native dependencies.
 *
 * Architecture:
 *   Input(47) → BatchNorm → Linear(47,128) → ReLU
 *             → Linear(128,64) → ReLU → Linear(64,1)
 *
 * Weights JSON shape (written by Python `torch.save` → JSON dump):
 *
 *   { architecture: { input_dim, hidden: [128, 64], output_dim: 1 },
 *     bn: { weight, bias, running_mean, running_var, eps },
 *     layers: [
 *       { weight: [[...]], bias: [...] },   // 128×47
 *       { weight: [[...]], bias: [...] },   // 64×128
 *       { weight: [[...]], bias: [...] }    // 1×64
 *     ] }
 *
 * Inference cost is O(input_dim × hidden[0] + hidden[0] × hidden[1] + ...)
 * which works out to ~20 µs per query for the default architecture.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ── primitives ───────────────────────────────────────────────────

/**
 * BatchNorm inference: y = (x - mean) / sqrt(var + eps) * gamma + beta
 *
 * @param {Float64Array} x        input vector
 * @param {{weight:number[], bias:number[], running_mean:number[], running_var:number[], eps?:number}} bn
 * @returns {Float64Array}
 */
function batchNormInfer(x, bn) {
  const eps = bn.eps ?? 1e-5;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const normed = (x[i] - bn.running_mean[i]) / Math.sqrt(bn.running_var[i] + eps);
    out[i] = normed * bn.weight[i] + bn.bias[i];
  }
  return out;
}

/**
 * Linear layer: y = W·x + b
 * W is [out_dim, in_dim], x is [in_dim], b is [out_dim].
 *
 * @param {Float64Array} x
 * @param {{weight:number[][], bias:number[]}} layer
 * @returns {Float64Array}
 */
function linearForward(x, layer) {
  const outDim = layer.weight.length;
  const out = new Float64Array(outDim);
  for (let r = 0; r < outDim; r++) {
    const row = layer.weight[r];
    let s = layer.bias[r];
    for (let c = 0; c < row.length; c++) {
      s += row[c] * x[c];
    }
    out[r] = s;
  }
  return out;
}

/**
 * ReLU activation (in-place-safe; returns a new array).
 *
 * @param {Float64Array} x
 * @returns {Float64Array}
 */
function relu(x) {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] > 0 ? x[i] : 0;
  }
  return out;
}

// ── forward pass ─────────────────────────────────────────────────

/**
 * Full MLP forward pass.
 *
 * @param {ArrayLike<number>} x        feature vector (length = input_dim)
 * @param {Object}            weights  parsed JSON weights
 * @returns {number}                   scalar prediction
 */
export function mlpForward(x, weights) {
  let h = new Float64Array(x);

  // BatchNorm (inference mode — uses running stats)
  if (weights.bn) {
    h = batchNormInfer(h, weights.bn);
  }

  // Hidden layers with ReLU (all except the last)
  const layers = weights.layers;
  for (let i = 0; i < layers.length - 1; i++) {
    h = linearForward(h, layers[i]);
    h = relu(h);
  }

  // Output layer (no activation)
  const out = linearForward(h, layers[layers.length - 1]);
  return out[0]; // scalar
}

// ── loading ──────────────────────────────────────────────────────

/**
 * Load MLP weights from a single JSON file.
 *
 * @param {string} filePath
 * @returns {Promise<Object>}
 */
export async function loadMLPWeights(filePath) {
  const text = await readFile(filePath, "utf-8");
  return JSON.parse(text);
}

/**
 * Load all MLP quantile heads from a directory.
 *
 * Expected layout (mirrors the GBDT bundle):
 *
 *   mlp/
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
export async function loadMLPBundle(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  const heads = {};

  for (const [tgt, qmap] of Object.entries(manifest.files || {})) {
    heads[tgt] = {};
    for (const [qname, fname] of Object.entries(qmap)) {
      const file = path.join(dir, fname);
      if (!existsSync(file)) {
        throw new Error(`mlp bundle ${dir}: manifest references missing weights ${fname}`);
      }
      heads[tgt][qname] = await loadMLPWeights(file);
    }
  }

  return { manifest, heads, dir };
}

// ── bundle prediction ────────────────────────────────────────────

/**
 * Predict all targets using a loaded MLP bundle.
 *
 * Same interface as `predictBundle` in gbdt.mjs:
 * returns `{ [target]: { p10, p50, p90 } }` in raw units.
 *
 * Models are trained in log1p space; back-transform with expm1
 * unless the caller asks for raw log-space values. Quantile
 * crossings are forced monotone (p10 <= p50 <= p90).
 *
 * @param {Object} bundle   from loadMLPBundle
 * @param {ArrayLike<number>} x  feature vector
 * @param {{expm1?:boolean}} opts
 * @returns {Object<string, {p10:number, p50:number, p90:number}>}
 */
export function predictMLPBundle(bundle, x, { expm1: doExpm1 = true } = {}) {
  const out = {};
  for (const [tgt, heads] of Object.entries(bundle.heads)) {
    const p10 = mlpForward(x, heads.p10);
    const p50 = mlpForward(x, heads.p50);
    const p90 = mlpForward(x, heads.p90);

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
