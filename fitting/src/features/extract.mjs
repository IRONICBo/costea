/**
 * Structured feature extraction.
 *
 * Pulls a flat numeric/categorical feature record out of a Task.
 * Consumed two ways:
 *   - encoder.mjs flattens these into the GBDT input vector
 *   - the kNN layer uses them as tie-breakers / report-time context
 */

const SKILL_RE = /^\/([a-zA-Z0-9_-]+)/;
const FILE_PATH_RE = /(?:^|[\s`'"(])([\w./-]+\.(?:[a-zA-Z]{1,6}))(?=$|[\s`'")]|:)/g;
const CODE_FENCE_RE = /```/;
const CJK_RE = /[\u4e00-\u9fff]/;

/** Detect if the text is mostly CJK (used to pick a tokenizer mode). */
export function detectLang(text) {
  if (!text) return "unknown";
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else if (ch.charCodeAt(0) < 128) ascii++;
  }
  if (cjk === 0 && ascii === 0) return "unknown";
  return cjk > ascii ? "cjk" : "latin";
}

/**
 * Best-effort token estimate without pulling tiktoken.
 * Heuristic: ~4 chars/token for ASCII, ~1.7 chars/token for CJK
 * — gets within ±20% of tiktoken on real prompts, plenty for a feature.
 */
export function approxTokenCount(text) {
  if (!text) return 0;
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk / 1.7 + other / 4);
}

function extractSkillName(prompt) {
  const m = SKILL_RE.exec(prompt || "");
  return m ? m[1] : null;
}

function countFilePaths(prompt) {
  if (!prompt) return 0;
  // Reset lastIndex so the global regex is reusable.
  FILE_PATH_RE.lastIndex = 0;
  let n = 0;
  while (FILE_PATH_RE.exec(prompt)) n++;
  return n;
}

/** Normalise a Date timestamp into UTC hour-of-day and weekday (0=Mon). */
function timeFeatures(ts) {
  if (!ts) return { hour: -1, weekday: -1 };
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { hour: -1, weekday: -1 };
  // weekday: getUTCDay returns 0=Sun..6=Sat — remap to 0=Mon..6=Sun
  const wd = (d.getUTCDay() + 6) % 7;
  return { hour: d.getUTCHours(), weekday: wd };
}

/**
 * Compute the full structured feature vector for one task.
 *
 * @param {import("../data/loader.mjs").Task} task
 * @returns {Object}
 */
export function extractFeatures(task) {
  const prompt = task.user_prompt || "";
  const skill = task.skill_name || extractSkillName(prompt);
  const { hour, weekday } = timeFeatures(task.timestamp);

  return {
    // text shape
    prompt_chars: prompt.length,
    prompt_words: prompt.trim().split(/\s+/).filter(Boolean).length,
    prompt_approx_tokens: approxTokenCount(prompt),
    prompt_lang: detectLang(prompt),
    prompt_has_code: CODE_FENCE_RE.test(prompt) ? 1 : 0,
    prompt_file_path_count: countFilePaths(prompt),

    // categorical
    is_skill: task.is_skill || prompt.startsWith("/") ? 1 : 0,
    skill_name: skill,
    source: task.source,
    model: task.model,

    // session sequencing (provided by loader.annotateSequence)
    turn_index: task.turn_index ?? 0,
    prior_session_input: task.prior_session_input ?? 0,
    prior_session_output: task.prior_session_output ?? 0,
    prior_session_cache_read: task.prior_session_cache_read ?? 0,
    prior_session_total: task.prior_session_total ?? 0,
    is_first_turn: (task.turn_index ?? 0) === 0 ? 1 : 0,

    // time
    hour_of_day: hour,
    weekday: weekday,
  };
}

/**
 * Extract features for a query that hasn't run yet (no token usage,
 * no session context). Used at predict-time.
 *
 * @param {string} prompt
 * @param {{source?:string, model?:string, turn_index?:number, prior_session_total?:number}} ctx
 */
export function extractQueryFeatures(prompt, ctx = {}) {
  return extractFeatures({
    user_prompt: prompt,
    is_skill: prompt.startsWith("/"),
    skill_name: extractSkillName(prompt),
    source: ctx.source ?? "unknown",
    model: ctx.model ?? "unknown",
    timestamp: new Date().toISOString(),
    turn_index: ctx.turn_index ?? 0,
    prior_session_input: ctx.prior_session_input ?? 0,
    prior_session_output: ctx.prior_session_output ?? 0,
    prior_session_cache_read: ctx.prior_session_cache_read ?? 0,
    prior_session_total: ctx.prior_session_total ?? 0,
  });
}
