#!/usr/bin/env node
/**
 * Score the current production heuristic on the test split.
 *
 * Loads ~/.costea/task-index.json, time-splits 80/10/10, and runs the
 * ported `estimator.ts` on each test task using only the train+val
 * portions as history. Prints regression metrics for input, output,
 * cache_read, tool_calls, and a derived cost (Sonnet 4.6 prices).
 *
 * Used as the "before" column when comparing against the ML methods.
 *
 * Usage:
 *   node scripts/eval-baseline.mjs [--json]
 */

import { loadSplit } from "../src/data/loader.mjs";
import { estimate } from "../src/baseline/estimator.mjs";
import { summarize } from "../src/metrics/regression.mjs";
import { sonnetCost as priceCost } from "../src/prices.mjs";

function fmtNum(n) {
  if (n === null || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function pct(n) {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function printTable(label, summary) {
  console.log(`\n── ${label} (n=${summary.n}) ───────────────────────`);
  console.log(`  MAPE          : ${pct(summary.mape)}`);
  console.log(`  median APE    : ${pct(summary.median_ape)}`);
  console.log(`  log-RMSE      : ${fmtNum(summary.log_rmse)}`);
  console.log(`  bias (P-A)    : ${fmtNum(summary.bias)}`);
  console.log(`  within ±25%   : ${pct(summary.within_25pct)}`);
  console.log(`  within ±50%   : ${pct(summary.within_50pct)}`);
}

async function main() {
  const json = process.argv.includes("--json");
  if (!json) console.error("Loading task index…");
  const split = await loadSplit();
  if (!json) {
    console.error(`Total usable tasks: ${split.total}`);
    console.error(`Train: ${split.train.length}  Val: ${split.val.length}  Test: ${split.test.length}`);
    console.error(`Test cutoff after: ${split.cutoffs.valEnd}`);
  }

  const history = [...split.train, ...split.val];
  const test = split.test;

  const A = { input: [], output: [], cache_read: [], tools: [], cost: [] };
  const P = { input: [], output: [], cache_read: [], tools: [], cost: [] };
  const methodCounts = {};

  let i = 0;
  for (const t of test) {
    i++;
    if (!json && i % 50 === 0) process.stderr.write(`\r  predicting ${i}/${test.length}…`);
    const est = estimate(t.user_prompt || "", history, new Date(t.timestamp));
    methodCounts[est.method] = (methodCounts[est.method] || 0) + 1;
    A.input.push(t.token_usage.input || 0);
    A.output.push(t.token_usage.output || 0);
    A.cache_read.push(t.token_usage.cache_read || 0);
    A.tools.push(t.total_tool_calls || 0);
    A.cost.push(priceCost({
      input: t.token_usage.input,
      output: t.token_usage.output,
      cache_read: t.token_usage.cache_read,
    }));
    P.input.push(est.input);
    P.output.push(est.output);
    P.cache_read.push(est.cache_read);
    P.tools.push(est.tool_calls);
    P.cost.push(priceCost(est));
  }
  if (!json) process.stderr.write("\n");

  const out = {
    method: "baseline_estimator_ts",
    n_test: test.length,
    method_counts: methodCounts,
    metrics: {
      input:      summarize(A.input,      P.input,      "input_tokens"),
      output:     summarize(A.output,     P.output,     "output_tokens"),
      cache_read: summarize(A.cache_read, P.cache_read, "cache_read_tokens"),
      tools:      summarize(A.tools,      P.tools,      "tool_calls"),
      cost:       summarize(A.cost,       P.cost,       "cost_usd"),
    },
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n=== Baseline (current estimator.ts heuristic) ===`);
  console.log(`Strategy mix on test set:`);
  for (const [m, c] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}: ${c} (${pct(c / test.length)})`);
  }
  for (const [k, s] of Object.entries(out.metrics)) printTable(k, s);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
