#!/usr/bin/env node
/**
 * Node.js wrapper for the Python training pipeline.
 * Checks dependencies, refreshes the index, trains, and records history.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FITTING_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(FITTING_ROOT, "..");
const COSTEA_DIR = path.join(os.homedir(), ".costea");
const INDEX_PATH = path.join(COSTEA_DIR, "task-index.json");
const MODELS_DIR = path.join(COSTEA_DIR, "models");
const HISTORY_PATH = path.join(COSTEA_DIR, "training-history.jsonl");
const BUILD_INDEX_SH = path.join(REPO_ROOT, "skills", "costea", "scripts", "build-index.sh");

const ONE_HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    incremental: false,
    out: MODELS_DIR,
    numTrees: null,
    leaves: null,
    evaluate: false,
    help: false,
    extra: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { opts.help = true; continue; }
    if (a === "--incremental") { opts.incremental = true; continue; }
    if (a === "--evaluate") { opts.evaluate = true; continue; }
    if (a === "--out") { opts.out = args[++i]; continue; }
    if (a.startsWith("--out=")) { opts.out = a.slice(6); continue; }
    if (a === "--num-trees") { opts.numTrees = args[++i]; continue; }
    if (a.startsWith("--num-trees=")) { opts.numTrees = a.slice(12); continue; }
    if (a === "--leaves") { opts.leaves = args[++i]; continue; }
    if (a.startsWith("--leaves=")) { opts.leaves = a.slice(9); continue; }
    opts.extra.push(a);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/train.mjs [options]

Options:
  --incremental       Warm-start on existing model (incremental mode)
  --out <dir>         Custom output directory (default: ~/.costea/models/)
  --num-trees <n>     Number of boosting rounds (passed to train.py)
  --leaves <n>        Number of leaves per tree (passed to train.py)
  --evaluate          Run eval-gbdt.mjs after training
  -h, --help          Show this help message`);
}

/** Run a command and return a promise that resolves with the exit code. */
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function checkPython() {
  try {
    execSync("python3 -c 'import lightgbm'", { stdio: "pipe" });
  } catch {
    console.error(
      "Error: python3 with lightgbm is required but not available.\n" +
      "Install with:  pip install lightgbm\n" +
      "On macOS you also need libomp:  brew install libomp"
    );
    process.exit(1);
  }
}

async function refreshIndexIfNeeded() {
  let needsRefresh = false;

  if (!existsSync(INDEX_PATH)) {
    console.error("Task index not found, building...");
    needsRefresh = true;
  } else {
    const st = await stat(INDEX_PATH);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > ONE_HOUR_MS) {
      console.error(`Task index is ${Math.round(ageMs / 60_000)} min old, refreshing...`);
      needsRefresh = true;
    }
  }

  if (!needsRefresh) return;

  if (!existsSync(BUILD_INDEX_SH)) {
    console.error(`Warning: build-index.sh not found at ${BUILD_INDEX_SH}, skipping index refresh.`);
    if (!existsSync(INDEX_PATH)) {
      console.error("Error: no task index available and cannot build one. Aborting.");
      process.exit(1);
    }
    return;
  }

  const code = await spawnAsync("bash", [BUILD_INDEX_SH], { stdio: "inherit" });
  if (code !== 0) {
    console.error(`build-index.sh exited with code ${code}`);
    process.exit(1);
  }
}

function buildTrainArgs(opts) {
  const args = [
    "training/train.py",
    "--index", INDEX_PATH,
    "--out", opts.out,
  ];
  if (opts.numTrees) args.push("--num-trees", String(opts.numTrees));
  if (opts.leaves) args.push("--leaves", String(opts.leaves));
  if (opts.incremental) {
    args.push("--mode", "incremental", "--init-model", opts.out);
  }
  args.push(...opts.extra);
  return args;
}

async function recordHistory(opts, durationMs, exitCode) {
  await mkdir(COSTEA_DIR, { recursive: true });

  const record = {
    timestamp: new Date().toISOString(),
    mode: opts.incremental ? "incremental" : "full",
    duration_ms: durationMs,
    status: exitCode === 0 ? "success" : "failure",
    trigger: "manual",
    out: opts.out,
  };

  // Enrich from manifest if training succeeded.
  if (exitCode === 0) {
    const manifestPath = path.join(opts.out, "manifest.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      record.tasks = manifest.n_train;
      record.trees = manifest.params?.num_trees;
      record.trained_at = manifest.trained_at;
    } catch {
      // Manifest may not exist for failed/partial runs — that's OK.
    }
  }

  await appendFile(HISTORY_PATH, JSON.stringify(record) + "\n");
}

async function runEval(opts) {
  console.error("\nRunning evaluation...");
  const evalScript = path.join(HERE, "eval-gbdt.mjs");
  const code = await spawnAsync(
    process.execPath,
    [evalScript, `--models=${opts.out}`],
    { stdio: "inherit", cwd: FITTING_ROOT },
  );
  if (code !== 0) {
    console.error(`eval-gbdt.mjs exited with code ${code}`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // 1. Check prerequisites.
  checkPython();

  // 2. Refresh index if stale or missing.
  await refreshIndexIfNeeded();

  // 3. Ensure output directory exists.
  await mkdir(opts.out, { recursive: true });

  // 4. Run Python training.
  const trainArgs = buildTrainArgs(opts);
  console.error(`\nSpawning: python3 ${trainArgs.join(" ")}`);
  const t0 = Date.now();
  const exitCode = await spawnAsync("python3", trainArgs, {
    stdio: "inherit",
    cwd: FITTING_ROOT,
  });
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    console.error(`\ntrain.py exited with code ${exitCode}`);
  } else {
    console.error(`\nTraining completed in ${(durationMs / 1000).toFixed(1)}s`);
  }

  // 5. Record result.
  await recordHistory(opts, durationMs, exitCode);

  // 6. Optional evaluation.
  if (opts.evaluate && exitCode === 0) {
    await runEval(opts);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
