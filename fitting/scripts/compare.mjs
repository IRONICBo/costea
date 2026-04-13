#!/usr/bin/env node
/**
 * Side-by-side report: baseline (current estimator.ts) vs ML pipeline.
 *
 * Spawns both evaluators with --json, then renders a comparison table
 * focused on the cost target (the main thing receipts show users) plus
 * a quick summary for tokens.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

function runJson(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, script), "--json"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b; });
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${script} exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function pct(n) { return n === null || !Number.isFinite(n) ? "n/a   " : `${(n*100).toFixed(1)}%`.padStart(7); }
function num(n, w = 8) { return n === null || !Number.isFinite(n) ? "n/a".padStart(w) : n.toFixed(3).padStart(w); }

function arrowFor(a, b, lowerIsBetter = true) {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return "  ";
  if (a === b) return "= ";
  const better = lowerIsBetter ? b < a : b > a;
  return better ? "✓ " : "✗ ";
}
function row(label, a, b, lowerIsBetter = true) {
  return `${label.padEnd(22)}  ${pct(a)}  →  ${pct(b)}  ${arrowFor(a, b, lowerIsBetter)}`;
}
function rowNum(label, a, b, w = 10, lowerIsBetter = true) {
  return `${label.padEnd(22)}  ${num(a, w)}  →  ${num(b, w)}  ${arrowFor(a, b, lowerIsBetter)}`;
}

async function main() {
  console.error("Running baseline…");
  const base = await runJson("eval-baseline.mjs");
  console.error("Running ML pipeline…");
  const ml = await runJson("eval-knn.mjs");

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Costea fitting — baseline vs Phase 1 ML (test split)            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`Test n: ${base.n_test} (cost target = Sonnet 4.6 prices)`);
  console.log(`Baseline strategy mix: ${Object.entries(base.method_counts).map(([k,v])=>`${k}=${v}`).join(", ")}`);
  console.log(`ML method: ${ml.method} (k=${ml.k}, vocab=${ml.vocab_size})\n`);

  for (const tgt of ["cost", "input", "output", "cache_read", "tools"]) {
    const b = base.metrics[tgt];
    const m = ml.metrics[tgt];
    const iv = ml.interval_metrics?.[tgt];
    console.log(`── ${tgt} ───────────────────────────────────────────────────`);
    console.log(`                          baseline          ML    `);
    console.log(row("  MAPE",          b.mape,           m.mape));
    console.log(row("  median APE",    b.median_ape,     m.median_ape));
    console.log(rowNum("  log-RMSE",   b.log_rmse,       m.log_rmse));
    console.log(row("  within ±25%",   b.within_25pct,   m.within_25pct, false));
    console.log(row("  within ±50%",   b.within_50pct,   m.within_50pct, false));
    if (iv) {
      console.log(`  P10–P90 coverage      : ${pct(iv.coverage_p10_p90)} (target 80%)`);
      console.log(`  Interval score        : ${num(iv.interval_score, 12)}  (ML only — lower is better)`);
    }
    console.log("");
  }

  // Headline number for the README badge / commit message.
  const before = base.metrics.cost.median_ape;
  const after = ml.metrics.cost.median_ape;
  const rel = (1 - after / before) * 100;
  console.log(`──────────────────────────────────────────────────────────────────`);
  console.log(`Cost median APE: ${pct(before).trim()} → ${pct(after).trim()}  (${rel.toFixed(1)}% relative reduction)`);
  console.log(`──────────────────────────────────────────────────────────────────`);
}

main().catch((e) => { console.error(e); process.exit(1); });
