/**
 * Numeric feature encoder shared between the JS runtime and the
 * Python training script.
 *
 * The boosted-tree predictor sees a fixed-order Float64 vector. To
 * keep training and inference consistent we centralise:
 *   1. The canonical feature ordering.
 *   2. The categorical encodings (skill / source / model / language).
 *
 * Categories not seen at train time fall through to a sentinel index
 * (-1). LightGBM handles -1 cleanly; trees never split on it.
 *
 * The training script reads the same JSON manifest emitted from
 * `defaultManifest()` so feature column N here is feature column N
 * over there.
 */

import { extractFeatures, extractQueryFeatures } from "./extract.mjs";

/** Static categorical vocabularies for the bundled demo model. */
const DEFAULT_SOURCES = ["claude-code", "codex", "openclaw", "unknown"];
const DEFAULT_MODELS = [
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
  "claude-opus-4-5", "claude-sonnet-4",
  "gpt-5.4", "gpt-5.2-codex",
  "gemini-2.5-pro", "gemini-2.5-flash",
  "unknown",
];
const DEFAULT_LANGS = ["latin", "cjk", "unknown"];

/** Canonical numeric column order. */
export const FEATURE_NAMES = Object.freeze([
  "prompt_chars",
  "prompt_words",
  "prompt_approx_tokens",
  "prompt_has_code",
  "prompt_file_path_count",
  "is_skill",
  "turn_index",
  "is_first_turn",
  "prior_session_input",
  "prior_session_output",
  "prior_session_cache_read",
  "prior_session_total",
  "hour_of_day",
  "weekday",
  "lang_idx",
  "source_idx",
  "model_idx",
  "skill_idx",
]);

/**
 * Build a default manifest. The Python trainer reads the same shape;
 * the model file's feature_names line MUST match `FEATURE_NAMES`.
 *
 * @param {string[]} skills  vocabulary for skill_name (sorted, deduped)
 */
export function defaultManifest(skills = []) {
  return {
    version: 1,
    feature_names: [...FEATURE_NAMES],
    categorical: {
      source: DEFAULT_SOURCES,
      model: DEFAULT_MODELS,
      lang: DEFAULT_LANGS,
      skill: skills,
    },
    targets: ["input", "output", "cache_read", "tools", "cost"],
    quantiles: [0.1, 0.5, 0.9],
  };
}

function lookup(vocab, value) {
  if (value == null) return -1;
  const idx = vocab.indexOf(value);
  return idx;
}

/**
 * Encode a structured feature record into a Float64Array in
 * `FEATURE_NAMES` order.
 *
 * @param {ReturnType<typeof extractFeatures>} f
 * @param {ReturnType<typeof defaultManifest>} manifest
 * @returns {Float64Array}
 */
export function encodeFeatures(f, manifest) {
  const cat = manifest.categorical;
  const out = new Float64Array(FEATURE_NAMES.length);
  out[0]  = f.prompt_chars;
  out[1]  = f.prompt_words;
  out[2]  = f.prompt_approx_tokens;
  out[3]  = f.prompt_has_code;
  out[4]  = f.prompt_file_path_count;
  out[5]  = f.is_skill;
  out[6]  = f.turn_index;
  out[7]  = f.is_first_turn;
  out[8]  = f.prior_session_input;
  out[9]  = f.prior_session_output;
  out[10] = f.prior_session_cache_read;
  out[11] = f.prior_session_total;
  out[12] = f.hour_of_day;
  out[13] = f.weekday;
  out[14] = lookup(cat.lang, f.prompt_lang);
  out[15] = lookup(cat.source, f.source);
  out[16] = lookup(cat.model, f.model);
  out[17] = lookup(cat.skill, f.skill_name);
  return out;
}

/** Convenience: encode a Task end-to-end. */
export function encodeTask(task, manifest) {
  return encodeFeatures(extractFeatures(task), manifest);
}

/** Convenience: encode a query (predict-time, no token usage). */
export function encodeQuery(prompt, ctx, manifest) {
  return encodeFeatures(extractQueryFeatures(prompt, ctx), manifest);
}

/**
 * Discover the skill vocabulary present in a task list — used by the
 * Python trainer to pin the manifest before fitting.
 */
export function collectSkills(tasks) {
  const set = new Set();
  for (const t of tasks) if (t.skill_name) set.add(t.skill_name);
  return [...set].sort();
}
