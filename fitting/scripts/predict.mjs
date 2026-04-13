#!/usr/bin/env node
/**
 * One-shot prediction CLI.
 *
 *   node scripts/predict.mjs "refactor the auth middleware to use JWT"
 *   node scripts/predict.mjs --source=claude-code --k=8 "/qa run all tests"
 *   node scripts/predict.mjs --json "fix the cache_read backfill bug"
 *
 * Loads ~/.costea/task-index.json, fits a Predictor, makes one
 * prediction, prints a receipt-style summary or raw JSON.
 */

import { Predictor } from "../src/index.mjs";

function parseArgs(argv) {
  const opts = { json: false, k: 10, source: undefined, model: undefined };
  const promptParts = [];
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a.startsWith("--source=")) opts.source = a.slice(9);
    else if (a.startsWith("--model=")) opts.model = a.slice(8);
    else if (a.startsWith("--k=")) opts.k = parseInt(a.slice(4), 10);
    else if (a === "--all") opts.all = true;
    else promptParts.push(a);
  }
  opts.prompt = promptParts.join(" ");
  return opts;
}

function fmtTokens(n) {
  if (n === null || !Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}
function fmtCost(n) {
  if (n === null || !Number.isFinite(n)) return "n/a";
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt) {
    console.error("Usage: predict.mjs [--source=X] [--model=X] [--k=N] [--all] [--json] <prompt>");
    process.exit(2);
  }

  if (!opts.json) console.error("Loading index + fitting predictor…");
  const p = opts.all ? await Predictor.fitFromIndexAll() : await Predictor.fitFromIndex();
  if (!opts.json) {
    console.error(`Predictor ready (train=${p.sizes.train} val=${p.sizes.val} vocab=${p.sizes.vocab})`);
  }

  const r = p.predict(opts.prompt, { source: opts.source, model: opts.model, k: opts.k });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!r.ok) {
    console.log(`✗ no prediction (${r.reason})`);
    return;
  }

  console.log(`\n┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`│  Costea fitting — prediction                                    │`);
  console.log(`└─────────────────────────────────────────────────────────────────┘`);
  console.log(`Task: ${opts.prompt}`);
  console.log(`Method: ${r.method}   confidence: ${r.confidence}%`);
  console.log("");
  console.log(`              P10        P50        P90`);
  for (const tgt of ["input", "output", "cache_read", "tools"]) {
    const v = r[tgt];
    const fmt = tgt === "tools" ? (n) => Math.round(n).toString() : fmtTokens;
    console.log(`  ${tgt.padEnd(11)} ${fmt(v.p10).padStart(8)}  ${fmt(v.p50).padStart(8)}  ${fmt(v.p90).padStart(8)}`);
  }
  console.log(`  cost (USD)  ${fmtCost(r.cost.p10).padStart(8)}  ${fmtCost(r.cost.p50).padStart(8)}  ${fmtCost(r.cost.p90).padStart(8)}`);
  console.log("");
  console.log(`Cross-provider cost (using P50 tokens):`);
  for (const pr of r.providers.slice(0, 5)) {
    console.log(`  ${pr.name.padEnd(22)} ${fmtCost(pr.cost)}`);
  }
  console.log(`  → best: ${r.best_provider.name}  ${fmtCost(r.best_provider.cost)}`);
  console.log("");
  console.log(`Top neighbours (evidence):`);
  for (const n of r.neighbours.slice(0, 5)) {
    const prompt = (n.prompt || "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  [${n.score.toFixed(2)}] ${(n.skill_name || n.source || "").padEnd(12)} ${fmtCost(n.actual.cost).padStart(8)}  | ${prompt}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
