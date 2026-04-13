/**
 * Pure-JS predictor for LightGBM models saved via `Booster.save_model()`.
 *
 * The text format is stable and self-describing — for each tree we
 * have parallel arrays describing splits, thresholds, child pointers,
 * and leaf values. We parse once, walk per query.
 *
 * Scope:
 *   - Numeric splits only (categorical features are passed as integer
 *     indices from `encoder.mjs` so trees treat them numerically).
 *   - Single-class regression objectives (regression, regression_l1,
 *     quantile). `objective=` is recorded for diagnostics.
 *   - Missing values follow the per-node default direction encoded in
 *     `decision_type` bit 0.
 *
 * Inference cost is O(depth × ntrees) ≈ ~10 µs per query for the
 * 100-tree depth-6 demo bundle.
 */

import { readFile } from "node:fs/promises";

const NEGATIVE = -1; // child < 0 means leaf at index -child-1

/**
 * @typedef {Object} GbdtTree
 * @property {Int32Array}   split_feature
 * @property {Float64Array} threshold
 * @property {Int32Array}   left_child   (negative = leaf)
 * @property {Int32Array}   right_child  (negative = leaf)
 * @property {Uint8Array}   decision_type
 * @property {Float64Array} leaf_value
 */

/**
 * @typedef {Object} GbdtModel
 * @property {string}      objective
 * @property {string[]}    feature_names
 * @property {number}      max_feature_idx
 * @property {GbdtTree[]}  trees
 */

function splitValues(line) {
  // LightGBM uses single-space separators in dumped arrays.
  return line.split(" ").filter((x) => x.length > 0);
}

function parseHeader(headerLines, model) {
  for (const line of headerLines) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    if (k === "objective") model.objective = v.trim();
    else if (k === "feature_names") model.feature_names = splitValues(v);
    else if (k === "max_feature_idx") model.max_feature_idx = parseInt(v, 10);
  }
}

function parseTree(block) {
  const tree = {
    split_feature: null,
    threshold: null,
    left_child: null,
    right_child: null,
    decision_type: null,
    leaf_value: null,
  };
  for (const line of block) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    switch (k) {
      case "split_feature":
        tree.split_feature = Int32Array.from(splitValues(v).map((x) => parseInt(x, 10)));
        break;
      case "threshold":
        tree.threshold = Float64Array.from(splitValues(v).map((x) => parseFloat(x)));
        break;
      case "left_child":
        tree.left_child = Int32Array.from(splitValues(v).map((x) => parseInt(x, 10)));
        break;
      case "right_child":
        tree.right_child = Int32Array.from(splitValues(v).map((x) => parseInt(x, 10)));
        break;
      case "decision_type":
        tree.decision_type = Uint8Array.from(splitValues(v).map((x) => parseInt(x, 10) & 0xff));
        break;
      case "leaf_value":
        tree.leaf_value = Float64Array.from(splitValues(v).map((x) => parseFloat(x)));
        break;
    }
  }
  // Sanity: all-leaf tree (single root leaf) has no internal nodes.
  if (tree.split_feature === null) {
    return {
      split_feature: new Int32Array(0),
      threshold: new Float64Array(0),
      left_child: new Int32Array(0),
      right_child: new Int32Array(0),
      decision_type: new Uint8Array(0),
      leaf_value: tree.leaf_value ?? new Float64Array([0]),
    };
  }
  return tree;
}

/**
 * Parse a LightGBM-saved text model. Accepts the full file content.
 *
 * @param {string} text
 * @returns {GbdtModel}
 */
export function parseLightgbmText(text) {
  const lines = text.split(/\r?\n/);
  const model = {
    objective: "regression",
    feature_names: [],
    max_feature_idx: 0,
    trees: [],
  };

  // Find tree boundaries.
  const treeStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^Tree=\d+$/.test(lines[i].trim())) treeStarts.push(i);
  }

  // Header is everything before the first Tree= line.
  const headerEnd = treeStarts.length ? treeStarts[0] : lines.length;
  parseHeader(lines.slice(0, headerEnd), model);

  // Each tree block runs until the next Tree= or until "end of trees" /
  // EOF. We slice generously and let parseTree pick what it understands.
  for (let t = 0; t < treeStarts.length; t++) {
    const start = treeStarts[t] + 1;
    const end = t + 1 < treeStarts.length ? treeStarts[t + 1] : lines.length;
    const block = [];
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (line.startsWith("end of trees")) break;
      block.push(line);
    }
    model.trees.push(parseTree(block));
  }

  return model;
}

/** Convenience: parse from disk. */
export async function loadLightgbmText(filePath) {
  const text = await readFile(filePath, "utf-8");
  return parseLightgbmText(text);
}

/**
 * Walk one tree and return its leaf value for the given feature vector.
 *
 * @param {GbdtTree} tree
 * @param {ArrayLike<number>} x
 */
function predictTree(tree, x) {
  // Pure-leaf tree (no splits): the lone leaf value is the answer.
  if (tree.split_feature.length === 0) return tree.leaf_value[0];

  let node = 0;
  // Bound the loop to tree depth as a safety net against bad inputs.
  for (let step = 0; step < 1024; step++) {
    const f = tree.split_feature[node];
    const v = x[f];
    const threshold = tree.threshold[node];
    const dt = tree.decision_type[node];
    // Bit 0 of decision_type: if set, missing values go left (default).
    const defaultLeft = (dt & 0x01) === 0x01;

    let goLeft;
    if (Number.isFinite(v)) {
      goLeft = v <= threshold;
    } else {
      goLeft = defaultLeft;
    }

    const child = goLeft ? tree.left_child[node] : tree.right_child[node];
    if (child < 0) {
      // Leaf index: LightGBM stores left/right_child as -(leaf_idx + 1).
      return tree.leaf_value[-child - 1];
    }
    node = child;
  }
  // Should never happen with well-formed trees.
  return 0;
}

/**
 * Aggregate prediction across all trees.
 *
 * For quantile / regression objectives the prediction is just the sum
 * of leaf contributions. (Trees are saved with shrinkage already baked
 * into leaf_value.)
 *
 * @param {GbdtModel} model
 * @param {ArrayLike<number>} x
 */
export function predict(model, x) {
  let sum = 0;
  for (const t of model.trees) sum += predictTree(t, x);
  return sum;
}

/**
 * Bundle predictor that holds three quantile heads per target.
 * The training script writes one .txt file per (target, quantile)
 * and a manifest enumerating them.
 *
 * @typedef {Object} QuantileBundle
 * @property {Object} manifest
 * @property {Object<string, {p10:GbdtModel, p50:GbdtModel, p90:GbdtModel}>} heads
 */

/** Run all heads on one feature vector, returning {tgt: {p10,p50,p90}} in raw units. */
export function predictBundle(bundle, x, { expm1 = true } = {}) {
  const out = {};
  for (const [tgt, heads] of Object.entries(bundle.heads)) {
    const p10 = predict(heads.p10, x);
    const p50 = predict(heads.p50, x);
    const p90 = predict(heads.p90, x);
    // Models are trained on log1p(y); back-transform here unless the
    // caller wants raw log-space values for further math.
    const back = expm1 ? Math.expm1 : (z) => z;
    // Force monotone p10 ≤ p50 ≤ p90 in case quantile crossings happened.
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
