#!/usr/bin/env node
/**
 * Evaluate the bundled (or user-supplied) GBDT bundle on the test
 * split. Mirrors eval-knn.mjs so the comparison harness can swap
 * methods without touching the metrics code.
 *
 * Usage:
 *   node scripts/eval-gbdt.mjs [--json] [--models=fitting/models]
 */

import path from "node:path";
import { loadSplit } from "../src/data/loader.mjs";
import { defaultManifest, encodeTask } from "../src/features/encoder.mjs";
import { predictBundle } from "../src/models/gbdt.mjs";
import { loadBundle, defaultModelsDir } from "../src/models/bundle.mjs";
import { fitIntervalCalibrator, applyIntervalCalibrator } from "../src/models/calibration.mjs";
import { summarize } from "../src/metrics/regression.mjs";
import { summarizeIntervals } from "../src/metrics/coverage.mjs";
import { costFromTask } from "../src/prices.mjs";
function pct(n) { return n === null || !Number.isFinite(n) ? "n/a   " : `${(n*100).toFixed(1)}%`; }
function num(n) { return n === null || !Number.isFinite(n) ? "n/a" : (Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(4)); }

function getArg(name, def) {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

async function main() {
  const json = process.argv.includes("--json");
  const skipCalib = process.argv.includes("--no-calibrate");
  const modelsDir = getArg("models", defaultModelsDir());

  if (!json) console.error(`Loading bundle from ${modelsDir}…`);
  const bundle = await loadBundle(modelsDir);
  if (!bundle) {
    console.error(`No GBDT bundle at ${modelsDir}. Run training/train.py first.`);
    process.exit(2);
  }
  if (!json) console.error("Loading task index…");
  const split = await loadSplit();
  if (!json) console.error(`Train ${split.train.length}, val ${split.val.length}, test ${split.test.length}`);

  // Fit calibrators on val using GBDT outputs.
  const TARGETS = ["input", "output", "cache_read", "tools", "cost"];
  const calibrators = {};
  if (!skipCalib) {
    const valByTgt = Object.fromEntries(TARGETS.map((t) => [t, { preds: [], acts: [] }]));
    for (const t of split.val) {
      const x = encodeTask(t, bundle.manifest);
      const p = predictBundle(bundle, x);
      for (const tgt of TARGETS) {
        const a = tgt === "cost" ? costFromTask(t) :
                  tgt === "tools" ? (t.total_tool_calls || 0) :
                  (t.token_usage[tgt] || 0);
        valByTgt[tgt].preds.push(p[tgt]);
        valByTgt[tgt].acts.push(a);
      }
    }
    for (const tgt of TARGETS) {
      const { preds, acts } = valByTgt[tgt];
      if (preds.length >= 20) calibrators[tgt] = fitIntervalCalibrator(preds, acts);
    }
    if (!json) {
      console.error("Calibrators (val coverage before → after, width factor):");
      for (const [k, c] of Object.entries(calibrators)) {
        console.error(`  ${k.padEnd(11)} ${pct(c.coverageBefore)} → ${pct(c.coverageAfter)}  f=${c.widthFactor}`);
      }
    }
  }

  // Score on test.
  const acts = Object.fromEntries(TARGETS.map((t) => [t, []]));
  const p50s = Object.fromEntries(TARGETS.map((t) => [t, []]));
  const intervals = Object.fromEntries(TARGETS.map((t) => [t, []]));
  for (const t of split.test) {
    const x = encodeTask(t, bundle.manifest);
    const raw = predictBundle(bundle, x);
    for (const tgt of TARGETS) {
      let p = raw[tgt];
      if (calibrators[tgt]) p = applyIntervalCalibrator(calibrators[tgt], p);
      const a = tgt === "cost" ? costFromTask(t) :
                tgt === "tools" ? (t.total_tool_calls || 0) :
                (t.token_usage[tgt] || 0);
      acts[tgt].push(a);
      p50s[tgt].push(p.p50);
      intervals[tgt].push(p);
    }
  }

  const out = {
    method: skipCalib ? "gbdt_quantile" : "gbdt_quantile_calibrated",
    n_test: split.test.length,
    bundle: {
      dir: bundle.dir,
      trained_at: bundle.manifest.trained_at,
      n_train: bundle.manifest.n_train,
      n_val: bundle.manifest.n_val,
      tree_count: Object.values(bundle.heads).reduce((s, h) =>
        s + h.p10.trees.length + h.p50.trees.length + h.p90.trees.length, 0),
    },
    metrics: Object.fromEntries(TARGETS.map((t) => [t, summarize(acts[t], p50s[t], t)])),
    interval_metrics: Object.fromEntries(TARGETS.map((t) => [t, summarizeIntervals(acts[t], intervals[t], t)])),
    calibrators: Object.fromEntries(Object.entries(calibrators).map(([k, c]) => [k, {
      widthFactor: c.widthFactor, coverageBefore: c.coverageBefore, coverageAfter: c.coverageAfter,
    }])),
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n=== ${out.method} ===`);
  console.log(`bundle: ${out.bundle.dir}  trees=${out.bundle.tree_count}  trained_at=${out.bundle.trained_at}`);
  for (const tgt of TARGETS) {
    const m = out.metrics[tgt];
    const iv = out.interval_metrics[tgt];
    console.log(`\n── ${tgt} (n=${m.n}) ─────────────`);
    console.log(`  P50  MAPE       : ${pct(m.mape)}`);
    console.log(`  P50  median APE : ${pct(m.median_ape)}`);
    console.log(`  P50  log-RMSE   : ${num(m.log_rmse)}`);
    console.log(`  P50  within ±25%: ${pct(m.within_25pct)}`);
    console.log(`  P50  within ±50%: ${pct(m.within_50pct)}`);
    console.log(`  Interval cov.   : ${pct(iv.coverage_p10_p90)} (target 80%)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
