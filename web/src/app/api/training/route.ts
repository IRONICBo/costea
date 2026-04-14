import { NextResponse } from "next/server";
import { readFile, writeFile, appendFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import path from "path";
import { homedir } from "os";

export const dynamic = "force-dynamic";

const COSTEA_DIR = path.join(homedir(), ".costea");
const MODELS_DIR = path.join(COSTEA_DIR, "models");
const CONFIG_PATH = path.join(COSTEA_DIR, "training-config.json");
const HISTORY_PATH = path.join(COSTEA_DIR, "training-history.jsonl");
const INDEX_PATH = path.join(COSTEA_DIR, "task-index.json");

// Locate the fitting directory relative to the web project
const FITTING_DIR = path.resolve(process.cwd(), "..", "fitting");
const BUILTIN_MODELS = path.join(FITTING_DIR, "models");

interface TrainingConfig {
  enabled: boolean;
  mode: "full" | "incremental";
  schedule: { type: "daily" | "weekly"; day?: number; hour: number; minute: number };
  trigger: { min_new_tasks: number };
  params: { num_trees: number; incremental_trees: number; leaves: number; min_tasks: number };
  last_run: { timestamp: string; mode: string; tasks: number; duration_ms: number; status: string } | null;
}

const DEFAULT_CONFIG: TrainingConfig = {
  enabled: false,
  mode: "incremental",
  schedule: { type: "weekly", day: 0, hour: 3, minute: 0 },
  trigger: { min_new_tasks: 100 },
  params: { num_trees: 200, incremental_trees: 50, leaves: 31, min_tasks: 200 },
  last_run: null,
};

async function loadConfig(): Promise<TrainingConfig> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function loadManifest(dir: string) {
  const p = path.join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function getTaskCount(): Promise<number> {
  if (!existsSync(INDEX_PATH)) return 0;
  try {
    const idx = JSON.parse(await readFile(INDEX_PATH, "utf-8"));
    return Array.isArray(idx.tasks) ? idx.tasks.length : 0;
  } catch {
    return 0;
  }
}

async function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const text = await readFile(HISTORY_PATH, "utf-8");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

// GET: model status, config, and history
export async function GET() {
  const config = await loadConfig();
  const userManifest = await loadManifest(MODELS_DIR);
  const builtinManifest = await loadManifest(BUILTIN_MODELS);
  const taskCount = await getTaskCount();
  const history = await loadHistory();

  const activeModel = userManifest
    ? { source: "user", dir: MODELS_DIR, manifest: userManifest }
    : builtinManifest
      ? { source: "builtin", dir: BUILTIN_MODELS, manifest: builtinManifest }
      : null;

  const newTasksSince = activeModel?.manifest?.n_train
    ? Math.max(0, taskCount - activeModel.manifest.n_train)
    : taskCount;

  return NextResponse.json({
    active_model: activeModel,
    builtin_available: !!builtinManifest,
    config,
    task_count: taskCount,
    new_tasks_since: newTasksSince,
    history: history.slice(0, 20),
  });
}

// PUT: update training config
export async function PUT(req: Request) {
  const body = await req.json();
  const current = await loadConfig();
  const updated = { ...current, ...body };
  await writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return NextResponse.json({ ok: true, config: updated });
}

// POST: trigger training
export async function POST(req: Request) {
  const { mode = "full" } = await req.json();
  const config = await loadConfig();
  const trainScript = path.join(FITTING_DIR, "training", "train.py");

  if (!existsSync(trainScript)) {
    return NextResponse.json({ ok: false, error: "train.py not found at " + trainScript }, { status: 404 });
  }

  const args = [
    trainScript,
    "--index", INDEX_PATH,
    "--out", MODELS_DIR,
    "--num-trees", String(mode === "incremental" ? config.params.incremental_trees : config.params.num_trees),
    "--leaves", String(config.params.leaves),
    "--min-tasks", String(config.params.min_tasks),
  ];

  if (mode === "incremental") {
    args.push("--mode", "incremental", "--init-model", MODELS_DIR);
  }

  const startTime = Date.now();

  return new Promise<NextResponse>((resolve) => {
    execFile("python3", args, { cwd: FITTING_DIR, timeout: 300_000 }, async (err, stdout, stderr) => {
      const duration = Date.now() - startTime;
      const success = !err;

      const record = {
        timestamp: new Date().toISOString(),
        mode,
        tasks: await getTaskCount(),
        duration_ms: duration,
        status: success ? "success" : "error",
        trigger: "manual",
        error: success ? undefined : (err?.message || "unknown"),
      };

      // Record to history
      try {
        await appendFile(HISTORY_PATH, JSON.stringify(record) + "\n");
      } catch { /* ignore */ }

      // Update last_run in config
      if (success) {
        const cfg = await loadConfig();
        cfg.last_run = { timestamp: record.timestamp, mode, tasks: record.tasks, duration_ms: duration, status: "success" };
        await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      }

      resolve(NextResponse.json({
        ok: success,
        record,
        stdout: stdout?.slice(-2000),
        stderr: stderr?.slice(-2000),
      }, { status: success ? 200 : 500 }));
    });
  });
}

// DELETE: reset to built-in model
export async function DELETE() {
  const manifestPath = path.join(MODELS_DIR, "manifest.json");
  if (existsSync(manifestPath)) {
    const { rm } = await import("fs/promises");
    // Remove all model files in the user directory
    const manifest = await loadManifest(MODELS_DIR);
    if (manifest?.files) {
      for (const tgt of Object.values(manifest.files) as Record<string, string>[]) {
        for (const fname of Object.values(tgt)) {
          const fp = path.join(MODELS_DIR, fname);
          if (existsSync(fp)) await rm(fp);
        }
      }
    }
    await rm(manifestPath);
  }
  return NextResponse.json({ ok: true, message: "Reset to built-in model" });
}
