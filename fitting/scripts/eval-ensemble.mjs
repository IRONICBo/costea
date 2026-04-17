#!/usr/bin/env node
/**
 * Evaluate the ensemble (GBDT + MLP + Linear weighted blend) on the
 * test split. Requires at least two model types to be available.
 *
 * Usage:
 *   node scripts/eval-ensemble.mjs [--json]
 */

import path from "node:path";
import os from "node:os";
import { loadSplit } from "../src/data/loader.mjs";
import { encodeTask } from "../src/features/encoder.mjs";
import { loadBundle, defaultModelsDir } from "../src/models/bundle.mjs";
import { predictBundle } from "../src/models/gbdt.mjs";
import { loadMLPBundle, predictMLPBundle } from "../src/models/mlp.mjs";
import { loadLinearBundle, predictLinearBundle } from "../src/models/linear.mjs";
import { ensemblePredict } from "../src/models/ensemble.mjs";
import { fitIntervalCalibrator, applyIntervalCalibrator } from "../src/models/calibration.mjs";
import { summarize } from "../src/metrics/regression.mjs";
import { summarizeIntervals } from "../src/metrics/coverage.mjs";
import { costFromTask } from "../src/prices.mjs";

function pct(n) { return n === null || !Number.isFinite(n) ? "n/a   " : `${(n*100).toFixed(1)}%`; }
function num(n) { return n === null || !Number.isFinite(n) ? "n/a" : (Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(4)); }

async function main() {
  const json = process.argv.includes("--json");
  const skipCalib = process.argv.includes("--no-calibrate");

  // Load all available bundles.
  const userDir = path.join(os.homedir(), ".costea", "models");
  const gbdtBundle = await loadBundle(userDir).catch(() => null)
    || await loadBundle(defaultModelsDir()).catch(() => null);
  const mlpBundle = await loadMLPBundle(path.join(userDir, "mlp")).catch(() => null);
  const linearBundle = await loadLinearBundle(path.join(userDir, "linear")).catch(() => null);

  const available = [];
  if (gbdtBundle) available.push("gbdt");
  if (mlpBundle) available.push("mlp");
  if (linearBundle) available.push("linear");

  if (available.length < 2) {
    console.error(`Need at least 2 models for ensemble, found: ${available.join(", ") || "none"}`);
    process.exit(2);
  }

  if (!json) console.error(`Ensemble models: ${available.join(" + ")}`);
  if (!json) console.error("Loading task index…");
  const split = await loadSplit();
  if (!json) console.error(`Train ${split.train.length}, val ${split.val.length}, test ${split.test.length}`);

  function predictForTask(task) {
    const results = [];
    if (gbdtBundle) {
      const x = encodeTask(task, gbdtBundle.manifest);
      results.push({ type: "gbdt", predictions: predictBundle(gbdtBundle, x) });
    }
    if (mlpBundle) {
      const x = encodeTask(task, mlpBundle.manifest);
      results.push({ type: "mlp", predictions: predictMLPBundle(mlpBundle, x) });
    }
    if (linearBundle) {
      const x = encodeTask(task, linearBundle.manifest);
      results.push({ type: "linear", predictions: predictLinearBundle(linearBundle, x) });
    }
    return ensemblePredict(results);
  }

  const TARGETS = ["input", "output", "cache_read", "tools", "cost"];
  const calibrators = {};
  if (!skipCalib) {
    const valByTgt = Object.fromEntries(TARGETS.map((t) => [t, { preds: [], acts: [] }]));
    for (const t of split.val) {
      const p = predictForTask(t);
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
  }

  const acts = Object.fromEntries(TARGETS.map((t) => [t, []]));
  const p50s = Object.fromEntries(TARGETS.map((t) => [t, []]));
  const intervals = Object.fromEntries(TARGETS.map((t) => [t, []]));
  for (const t of split.test) {
    const raw = predictForTask(t);
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
    method: `ensemble_${available.join("+")}${skipCalib ? "" : "_calibrated"}`,
    n_test: split.test.length,
    models: available,
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
