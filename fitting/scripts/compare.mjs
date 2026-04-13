#!/usr/bin/env node
/**
 * Side-by-side report: baseline heuristic vs TF-IDF kNN vs GBDT bundle.
 *
 * Spawns each evaluator with --json, then renders a comparison table
 * across all three methods. The GBDT column is omitted gracefully if
 * no bundle is present (e.g. demo weights stripped from a checkout).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

function runJson(script, { optional = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, script), "--json"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b; });
    p.on("close", (code) => {
      if (code !== 0) {
        if (optional) return resolve(null);
        throw new Error(`${script} exited ${code}`);
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { if (optional) resolve(null); else throw e; }
    });
  });
}

function pct(n) { return n === null || !Number.isFinite(n) ? "n/a   " : `${(n*100).toFixed(1)}%`.padStart(7); }
function num(n, w = 8) { return n === null || !Number.isFinite(n) ? "n/a".padStart(w) : n.toFixed(3).padStart(w); }

function fmtCell(n, asPct = true, w = 11) {
  if (n === null || !Number.isFinite(n)) return "n/a".padStart(w);
  return asPct ? `${(n * 100).toFixed(1)}%`.padStart(w) : n.toFixed(3).padStart(w);
}

function bestOf(values, lowerIsBetter = true) {
  let bestIdx = -1, bestVal = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (bestVal === null) { bestVal = v; bestIdx = i; }
    else if (lowerIsBetter ? v < bestVal : v > bestVal) { bestVal = v; bestIdx = i; }
  }
  return bestIdx;
}

function row(label, values, asPct = true, lowerIsBetter = true) {
  const best = bestOf(values, lowerIsBetter);
  const cells = values.map((v, i) => {
    const c = fmtCell(v, asPct);
    return i === best ? `\x1b[32m${c}\x1b[0m` : c;
  });
  return `${label.padEnd(22)} ${cells.join("  ")}`;
}

async function main() {
  console.error("Running baseline…");
  const base = await runJson("eval-baseline.mjs");
  console.error("Running TF-IDF kNN…");
  const knn = await runJson("eval-knn.mjs");
  console.error("Running GBDT bundle…");
  const gbdt = await runJson("eval-gbdt.mjs", { optional: true });

  const methods = [
    { name: "baseline", data: base },
    { name: "knn",      data: knn },
    ...(gbdt ? [{ name: "gbdt", data: gbdt }] : []),
  ];

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Costea fitting — method comparison (test split)                 ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`Test n: ${base.n_test} (cost target = Sonnet 4.6 prices)`);
  for (const m of methods) {
    if (m.name === "baseline") {
      console.log(`baseline strategy mix: ${Object.entries(base.method_counts).map(([k,v])=>`${k}=${v}`).join(", ")}`);
    } else if (m.name === "knn") {
      console.log(`knn:  ${knn.method} (k=${knn.k}, vocab=${knn.vocab_size})`);
    } else if (m.name === "gbdt") {
      console.log(`gbdt: ${gbdt.method} (trees=${gbdt.bundle.tree_count}, trained_at=${gbdt.bundle.trained_at})`);
    }
  }

  const header = "                       " + methods.map((m) => m.name.padStart(11)).join("  ");
  for (const tgt of ["cost", "input", "output", "cache_read", "tools"]) {
    console.log(`\n── ${tgt} ───────────────────────────────────────────────────`);
    console.log(header);
    console.log(row("  MAPE",          methods.map((m) => m.data.metrics[tgt].mape)));
    console.log(row("  median APE",    methods.map((m) => m.data.metrics[tgt].median_ape)));
    console.log(row("  log-RMSE",      methods.map((m) => m.data.metrics[tgt].log_rmse), false));
    console.log(row("  within ±25%",   methods.map((m) => m.data.metrics[tgt].within_25pct), true, false));
    console.log(row("  within ±50%",   methods.map((m) => m.data.metrics[tgt].within_50pct), true, false));
    const covRow = methods.map((m) => m.data.interval_metrics?.[tgt]?.coverage_p10_p90 ?? null);
    if (covRow.some((x) => x !== null)) {
      console.log(row("  P10–P90 cover (80%)", covRow));
    }
  }

  console.log(`\n──────────────────────────────────────────────────────────────────`);
  const baseAPE = base.metrics.cost.median_ape;
  for (const m of methods.slice(1)) {
    const v = m.data.metrics.cost.median_ape;
    const rel = (1 - v / baseAPE) * 100;
    console.log(`cost median APE  ${m.name.padEnd(8)}: ${(v*100).toFixed(1)}%  (${rel >= 0 ? "-" : "+"}${Math.abs(rel).toFixed(1)}% vs baseline)`);
  }
  console.log(`──────────────────────────────────────────────────────────────────`);
}

main().catch((e) => { console.error(e); process.exit(1); });
