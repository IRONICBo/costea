/**
 * Load the canonical Costea task index, derive per-session sequencing
 * features, and split into train / val / test by **timestamp**.
 *
 * Random splits would let the same session leak across folds and the
 * cache_read distribution would inflate accuracy massively. Always
 * split by time.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_INDEX_PATH = path.join(
  homedir(),
  ".costea",
  "task-index.json",
);

/**
 * @typedef {Object} RawTask
 * @property {string} source
 * @property {string} session_id
 * @property {string} model
 * @property {string} timestamp
 * @property {boolean} is_skill
 * @property {string|null} skill_name
 * @property {string} user_prompt
 * @property {{input:number,output:number,cache_read:number,cache_write:number,total:number}} token_usage
 * @property {{total:number}} cost
 * @property {{name:string,count:number}[]} tools
 * @property {number} total_tool_calls
 */

/**
 * @typedef {RawTask & {
 *   turn_index: number,
 *   prior_session_input: number,
 *   prior_session_output: number,
 *   prior_session_cache_read: number,
 *   prior_session_total: number,
 * }} Task
 */

/** Load and parse `task-index.json`. */
export async function loadIndex(indexPath = DEFAULT_INDEX_PATH) {
  if (!existsSync(indexPath)) {
    throw new Error(`task-index.json not found at ${indexPath}. Run skills/costea/scripts/build-index.sh first.`);
  }
  const raw = await readFile(indexPath, "utf-8");
  const idx = JSON.parse(raw);
  if (!Array.isArray(idx.tasks)) {
    throw new Error(`malformed index: expected .tasks[] array`);
  }
  return idx;
}

/** Drop tasks with no useful signal (zero tokens, missing prompt). */
export function filterUsable(tasks) {
  return tasks.filter((t) =>
    t &&
    t.token_usage &&
    (t.token_usage.total || 0) > 0 &&
    typeof t.user_prompt === "string" &&
    t.user_prompt.trim().length > 0
  );
}

/**
 * Annotate each task with:
 *  - `turn_index`: 0-based position within its session, ascending by timestamp
 *  - `prior_session_*`: cumulative token usage in earlier turns of the same session
 *
 * cache_read in particular jumps from ~0 on turn 0 to 5–7 figures by turn 5+,
 * so this is the single most important derived feature for cache prediction.
 */
export function annotateSequence(tasks) {
  const bySession = new Map();
  for (const t of tasks) {
    const sid = t.session_id || "_orphan";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(t);
  }

  const annotated = [];
  for (const [, group] of bySession) {
    group.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    let prevIn = 0, prevOut = 0, prevCache = 0, prevTotal = 0;
    group.forEach((t, i) => {
      annotated.push({
        ...t,
        turn_index: i,
        prior_session_input: prevIn,
        prior_session_output: prevOut,
        prior_session_cache_read: prevCache,
        prior_session_total: prevTotal,
      });
      prevIn += t.token_usage.input || 0;
      prevOut += t.token_usage.output || 0;
      prevCache += t.token_usage.cache_read || 0;
      prevTotal += t.token_usage.total || 0;
    });
  }
  // Re-sort globally by timestamp so callers can split by time directly.
  annotated.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  return annotated;
}

/**
 * Time-based split. Default ratios: 80% train / 10% val / 10% test,
 * cut at quantile of timestamps so test is the most recent slice.
 *
 * @param {Task[]} tasks    must already be sorted by timestamp ascending
 * @param {{train?:number, val?:number}} ratios
 * @returns {{train:Task[], val:Task[], test:Task[], cutoffs:{trainEnd:string, valEnd:string}}}
 */
export function timeSplit(tasks, ratios = {}) {
  const trainRatio = ratios.train ?? 0.8;
  const valRatio = ratios.val ?? 0.1;
  const n = tasks.length;
  const trainEnd = Math.floor(n * trainRatio);
  const valEnd = Math.floor(n * (trainRatio + valRatio));
  const train = tasks.slice(0, trainEnd);
  const val = tasks.slice(trainEnd, valEnd);
  const test = tasks.slice(valEnd);
  return {
    train,
    val,
    test,
    cutoffs: {
      trainEnd: train.length ? train[train.length - 1].timestamp : "",
      valEnd: val.length ? val[val.length - 1].timestamp : "",
    },
  };
}

/** One-shot convenience: load + filter + annotate + split. */
export async function loadSplit(opts = {}) {
  const idx = await loadIndex(opts.indexPath);
  const usable = filterUsable(idx.tasks);
  const annotated = annotateSequence(usable);
  const split = timeSplit(annotated, opts.ratios);
  return {
    ...split,
    total: annotated.length,
    raw_count: idx.tasks.length,
    built_at: idx.built_at,
  };
}
