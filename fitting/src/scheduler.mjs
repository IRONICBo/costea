/**
 * Lazy training scheduler.
 *
 * Manages the training schedule configuration, determines whether a
 * new training run is due, and records training history.  All state
 * lives under ~/.costea/ so every CLI / UI consumer shares the same
 * schedule without coordination.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const COSTEA_DIR = path.join(os.homedir(), ".costea");
const CONFIG_PATH = path.join(COSTEA_DIR, "training-config.json");
const HISTORY_PATH = path.join(COSTEA_DIR, "training-history.jsonl");
const TASK_INDEX_PATH = path.join(COSTEA_DIR, "task-index.json");

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    enabled: false,
    mode: "incremental",
    schedule: { type: "weekly", day: 0, hour: 3, minute: 0 },
    trigger: { min_new_tasks: 100 },
    params: {
      num_trees: 200,
      incremental_trees: 50,
      leaves: 31,
      min_tasks: 200,
    },
    last_run: null,
  };
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

/**
 * Read the training config from ~/.costea/training-config.json.
 * Returns the parsed config object, or a default config if the file
 * doesn't exist.
 */
export async function loadTrainingConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (_) {
    return defaultConfig();
  }
}

/**
 * Write the training config to ~/.costea/training-config.json.
 */
export async function saveTrainingConfig(config) {
  if (!existsSync(COSTEA_DIR)) {
    await mkdir(COSTEA_DIR, { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Schedule logic
// ---------------------------------------------------------------------------

/**
 * Check if training should run based on schedule and data freshness.
 * Returns `{ shouldTrain: boolean, reason: string }`.
 */
export async function shouldTrain(config) {
  if (!config.enabled) {
    return { shouldTrain: false, reason: "disabled" };
  }

  if (!config.last_run) {
    return { shouldTrain: true, reason: "never_trained" };
  }

  const now = new Date();
  const lastRunDate = new Date(config.last_run.timestamp ?? config.last_run);
  const schedule = config.schedule ?? {};

  // --- Cron-like schedule check ---
  if (schedule.type === "daily") {
    const next = new Date(lastRunDate);
    next.setDate(next.getDate() + 1);
    next.setHours(schedule.hour ?? 3, schedule.minute ?? 0, 0, 0);
    if (now >= next) {
      return { shouldTrain: true, reason: "daily_schedule" };
    }
  } else if (schedule.type === "weekly") {
    const next = new Date(lastRunDate);
    next.setDate(next.getDate() + 7);
    next.setHours(schedule.hour ?? 3, schedule.minute ?? 0, 0, 0);
    // Align to the configured day-of-week.
    const dayTarget = schedule.day ?? 0; // 0 = Sunday
    while (next.getDay() !== dayTarget) {
      next.setDate(next.getDate() + 1);
    }
    if (now >= next) {
      return { shouldTrain: true, reason: "weekly_schedule" };
    }
  }

  // --- Data-freshness trigger ---
  const trigger = config.trigger ?? {};
  const minNew = trigger.min_new_tasks ?? 100;
  try {
    const raw = await readFile(TASK_INDEX_PATH, "utf-8");
    const idx = JSON.parse(raw);
    const currentTasks = (idx.tasks ?? []).length;
    const lastTasks = config.last_run.tasks ?? 0;
    if (currentTasks - lastTasks >= minNew) {
      return { shouldTrain: true, reason: "new_tasks_threshold" };
    }
  } catch (_) {
    // Task index missing or unreadable — can't assess freshness.
  }

  return { shouldTrain: false, reason: "not_due" };
}

// ---------------------------------------------------------------------------
// Training history
// ---------------------------------------------------------------------------

/**
 * Append a training run record to ~/.costea/training-history.jsonl.
 */
export async function recordTrainingRun(record) {
  if (!existsSync(COSTEA_DIR)) {
    await mkdir(COSTEA_DIR, { recursive: true });
  }
  const line = JSON.stringify(record) + "\n";
  await appendFile(HISTORY_PATH, line, "utf-8");
}

/**
 * Read the training history from ~/.costea/training-history.jsonl.
 * Returns an array of records, most recent first.
 */
export async function loadTrainingHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l)).reverse();
  } catch (_) {
    return [];
  }
}
