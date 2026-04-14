#!/usr/bin/env node
/**
 * Score the TF-IDF kNN + empirical quantile + isotonic/conformal
 * calibration pipeline on the test split.
 *
 * Same time-split + history pool as eval-baseline.mjs so the two
 * numbers are directly comparable.
 *
 * Usage:
 *   node scripts/eval-knn.mjs [--json] [--k=10] [--no-calibrate]
 */

import { loadSplit } from "../src/data/loader.mjs";
import { TfidfVectorizer } from "../src/retrieval/embed.mjs";
import { KnnIndex } from "../src/retrieval/knn.mjs";
import { empiricalPredict, attachTargets } from "../src/models/empirical.mjs";
import { fitIntervalCalibrator, applyIntervalCalibrator } from "../src/models/calibration.mjs";
import { summarize } from "../src/metrics/regression.mjs";
import { summarizeIntervals } from "../src/metrics/coverage.mjs";
import { costFromTask } from "../src/prices.mjs";

function pct(n) { return n === null || !Number.isFinite(n) ? "n/a" : `${(n*100).toFixed(1)}%`; }
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
  const K = parseInt(getArg("k", "10"), 10);

  if (!json) console.error("Loading task index…");
  const split = await loadSplit();
  if (!json) {
    console.error(`Train: ${split.train.length}  Val: ${split.val.length}  Test: ${split.test.length}`);
  }

  // Vectorize the training corpus.
  if (!json) console.error("Fitting TF-IDF on train…");
  const vec = new TfidfVectorizer().fit(split.train.map((t) => t.user_prompt));
  const trainVecs = split.train.map((t) => vec.transform(t.user_prompt));
  const trainMetas = split.train.map((t) => attachTargets(
    { skill_name: t.skill_name, source: t.source, timestamp: t.timestamp,
      prompt: (t.user_prompt || "").slice(0, 80) },
    t, costFromTask
  ));
  const trainIndex = new KnnIndex(trainVecs, trainMetas);
  if (!json) console.error(`TF-IDF vocab: ${vec.stats().vocab_size}`);

  // Predict on validation set first — used for calibration fitting.
  function predictFor(task) {
    const qVec = vec.transform(task.user_prompt);
    const qMeta = { skill_name: task.skill_name, source: task.source };
    const neigh = trainIndex.search(qVec, qMeta, {
      k: K, asOf: new Date(task.timestamp),
    });
    return { neigh, pred: empiricalPredict(neigh) };
  }

  if (!json) console.error("Predicting on validation set (calibration source)…");
  const valPreds = split.val.map(predictFor);

  // Fit calibrators per-target on val.
  const TARGETS = ["input", "output", "cache_read", "tools", "cost"];
  const calibrators = {};
  if (!skipCalib) {
    for (const tgt of TARGETS) {
      const preds = [];
      const acts = [];
      for (let i = 0; i < split.val.length; i++) {
        const p = valPreds[i].pred;
        if (!p.ok) continue;
        preds.push(p.predictions[tgt]);
        const a = tgt === "cost" ? costFromTask(split.val[i]) :
                  tgt === "tools" ? (split.val[i].total_tool_calls || 0) :
                  (split.val[i].token_usage[tgt] || 0);
        acts.push(a);
      }
      if (preds.length >= 20) {
        calibrators[tgt] = fitIntervalCalibrator(preds, acts);
      }
    }
    if (!json) {
      console.error("Calibrators (val coverage before → after, width factor):");
      for (const [k, c] of Object.entries(calibrators)) {
        console.error(`  ${k.padEnd(11)} ${pct(c.coverageBefore)} → ${pct(c.coverageAfter)}  f=${c.widthFactor}`);
      }
    }
  }

  // Predict on test.
  if (!json) console.error("Predicting on test set…");
  const testPreds = split.test.map(predictFor);

  // Build per-target metrics tables.
  const out = {
    method: skipCalib ? "tfidf_knn_empirical" : "tfidf_knn_empirical_calibrated",
    k: K,
    n_test: split.test.length,
    vocab_size: vec.stats().vocab_size,
    metrics: {},
    interval_metrics: {},
    calibrators: Object.fromEntries(
      Object.entries(calibrators).map(([k, c]) => [k, {
        widthFactor: c.widthFactor,
        coverageBefore: c.coverageBefore,
        coverageAfter: c.coverageAfter,
      }])
    ),
  };

  for (const tgt of TARGETS) {
    const acts = [];
    const p50s = [];
    const intervals = [];
    for (let i = 0; i < split.test.length; i++) {
      const p = testPreds[i].pred;
      if (!p.ok) continue;
      let pred = p.predictions[tgt];
      if (calibrators[tgt]) pred = applyIntervalCalibrator(calibrators[tgt], pred);
      const a = tgt === "cost" ? costFromTask(split.test[i]) :
                tgt === "tools" ? (split.test[i].total_tool_calls || 0) :
                (split.test[i].token_usage[tgt] || 0);
      acts.push(a);
      p50s.push(pred.p50);
      intervals.push(pred);
    }
    out.metrics[tgt] = summarize(acts, p50s, tgt);
    out.interval_metrics[tgt] = summarizeIntervals(acts, intervals, tgt);
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n=== ${out.method} (k=${K}) ===`);
  for (const tgt of TARGETS) {
    const m = out.metrics[tgt];
    const iv = out.interval_metrics[tgt];
    console.log(`\n── ${tgt} (n=${m.n}) ─────────────`);
    console.log(`  P50  MAPE       : ${pct(m.mape)}`);
    console.log(`  P50  median APE : ${pct(m.median_ape)}`);
    console.log(`  P50  log-RMSE   : ${num(m.log_rmse)}`);
    console.log(`  P50  within ±25%: ${pct(m.within_25pct)}`);
    console.log(`  Interval cov.   : ${pct(iv.coverage_p10_p90)} (target 80%)`);
    console.log(`  Interval score  : ${num(iv.interval_score)}  (lower=better)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
