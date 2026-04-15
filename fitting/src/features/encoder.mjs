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

import { extractFeatures, extractQueryFeatures, KEYWORD_GROUPS, TASK_TYPES } from "./extract.mjs";
import { tokenize } from "../retrieval/tokenizer.mjs";

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

/** Number of SVD components stored in the manifest. */
export const SVD_DIMS = 16;

/** Canonical numeric column order — 18 original + 1 task_type + 12 kw + 16 svd = 47. */
export const FEATURE_NAMES = Object.freeze([
  // --- original 18 ---
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
  // --- task type (1) ---
  "task_type_idx",
  // --- keyword-group binary (12) ---
  ...KEYWORD_GROUPS.map((g) => g.name),
  // --- TF-IDF SVD components (16) ---
  ...Array.from({ length: SVD_DIMS }, (_, i) => `svd_${i}`),
]);

/**
 * Build a default manifest. The Python trainer reads the same shape;
 * the model file's feature_names line MUST match `FEATURE_NAMES`.
 *
 * @param {string[]} skills  vocabulary for skill_name (sorted, deduped)
 */
export function defaultManifest(skills = []) {
  return {
    version: 2,
    feature_names: [...FEATURE_NAMES],
    categorical: {
      source: DEFAULT_SOURCES,
      model: DEFAULT_MODELS,
      lang: DEFAULT_LANGS,
      skill: skills,
      task_type: TASK_TYPES,
    },
    targets: ["input", "output", "cache_read", "tools", "cost"],
    quantiles: [0.1, 0.5, 0.9],
    svd_dims: SVD_DIMS,
    // svd_components: null — filled by the Python trainer after PCA
  };
}

function lookup(vocab, value) {
  if (value == null) return -1;
  const idx = vocab.indexOf(value);
  return idx;
}

// ---------------------------------------------------------------------------
// SVD projection (JS inference side)
// ---------------------------------------------------------------------------

/**
 * Project a prompt's TF-IDF vector onto the SVD basis stored in the
 * manifest.  Returns a Float64Array of length `svd_dims`.
 *
 * The manifest carries:
 *   svd_vocab: string[]                   term vocabulary (same order as columns)
 *   svd_components: number[][]            [svd_dims × vocab_size] row-major
 *   svd_idf: number[]                     IDF weights for each vocab term
 *
 * At inference the computation is:
 *   1. Tokenize prompt → count terms
 *   2. Build dense TF-IDF row using svd_vocab + svd_idf
 *   3. Matrix multiply by svd_components (dims × vocab) → dims-length vector
 */
export function svdProject(prompt, manifest) {
  const dims = manifest.svd_dims ?? SVD_DIMS;
  const result = new Float64Array(dims);
  const comp = manifest.svd_components;
  const vocab = manifest.svd_vocab;
  const idfArr = manifest.svd_idf;
  if (!comp || !vocab || !idfArr) return result; // no SVD info → zeros

  // Build a term→index map (cached on manifest for repeated calls)
  if (!manifest._svdVocabMap) {
    manifest._svdVocabMap = new Map();
    for (let i = 0; i < vocab.length; i++) manifest._svdVocabMap.set(vocab[i], i);
  }
  const vocabMap = manifest._svdVocabMap;

  // Tokenize and count
  const counts = new Map();
  for (const tok of tokenize(prompt || "")) {
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }

  // Build dense TF-IDF row, L2-normalize, then project
  const tfidfRow = new Float64Array(vocab.length);
  let norm = 0;
  for (const [tok, c] of counts) {
    const col = vocabMap.get(tok);
    if (col === undefined) continue;
    const v = (1 + Math.log(c)) * idfArr[col];
    tfidfRow[col] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < tfidfRow.length; i++) tfidfRow[i] /= norm;
  }

  // Project: result[d] = sum_j( comp[d][j] * tfidfRow[j] )
  for (let d = 0; d < dims; d++) {
    const row = comp[d];
    let s = 0;
    for (let j = 0; j < row.length; j++) {
      if (tfidfRow[j] !== 0) s += row[j] * tfidfRow[j];
    }
    result[d] = s;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode a structured feature record into a Float64Array in
 * `FEATURE_NAMES` order.
 *
 * @param {ReturnType<typeof extractFeatures>} f
 * @param {ReturnType<typeof defaultManifest>} manifest
 * @param {string} [prompt]  raw prompt text for SVD projection
 * @returns {Float64Array}
 */
export function encodeFeatures(f, manifest, prompt) {
  const cat = manifest.categorical;
  const out = new Float64Array(FEATURE_NAMES.length);
  let i = 0;

  // original 18
  out[i++] = f.prompt_chars;
  out[i++] = f.prompt_words;
  out[i++] = f.prompt_approx_tokens;
  out[i++] = f.prompt_has_code;
  out[i++] = f.prompt_file_path_count;
  out[i++] = f.is_skill;
  out[i++] = f.turn_index;
  out[i++] = f.is_first_turn;
  out[i++] = f.prior_session_input;
  out[i++] = f.prior_session_output;
  out[i++] = f.prior_session_cache_read;
  out[i++] = f.prior_session_total;
  out[i++] = f.hour_of_day;
  out[i++] = f.weekday;
  out[i++] = lookup(cat.lang, f.prompt_lang);
  out[i++] = lookup(cat.source, f.source);
  out[i++] = lookup(cat.model, f.model);
  out[i++] = lookup(cat.skill, f.skill_name);

  // task_type_idx (1)
  out[i++] = lookup(cat.task_type ?? TASK_TYPES, f.task_type);

  // keyword-group binary (12)
  for (const g of KEYWORD_GROUPS) {
    out[i++] = f[g.name] ?? 0;
  }

  // SVD components (16)
  const svd = svdProject(prompt, manifest);
  for (let d = 0; d < (manifest.svd_dims ?? SVD_DIMS); d++) {
    out[i++] = svd[d];
  }

  return out;
}

/** Convenience: encode a Task end-to-end. */
export function encodeTask(task, manifest) {
  return encodeFeatures(extractFeatures(task), manifest, task.user_prompt);
}

/** Convenience: encode a query (predict-time, no token usage). */
export function encodeQuery(prompt, ctx, manifest) {
  return encodeFeatures(extractQueryFeatures(prompt, ctx), manifest, prompt);
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
