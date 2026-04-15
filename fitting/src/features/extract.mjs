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

/**
 * Keyword-group detectors — each maps to a 0/1 feature that gives
 * the GBDT semantic signal about the task intent.
 */
export const KEYWORD_GROUPS = Object.freeze([
  { name: "kw_test",     re: /\btest|测试|spec|coverage|assert|jest|vitest|mocha/i },
  { name: "kw_refactor", re: /\brefactor|重构|rewrite|重写|migrat|迁移|rename|重命名/i },
  { name: "kw_fix",      re: /\bfix|修复|bug|error|报错|crash|issue|问题/i },
  { name: "kw_create",   re: /\bcreate|创建|implement|实现|add\b|新增|build|构建/i },
  { name: "kw_read",     re: /\bread\b|explain|解释|review|审查|analyz|分析|understand|理解/i },
  { name: "kw_deploy",   re: /\bdeploy|部署|release|发布|\bci\b|\bcd\b|pipeline|docker/i },
  { name: "kw_doc",      re: /\bdoc|文档|readme|comment|注释|changelog/i },
  { name: "kw_config",   re: /\bconfig|配置|\benv\b|settings|setup|install|安装/i },
  { name: "kw_perf",     re: /\bperf|性能|optimiz|优化|speed|cache|缓存|fast|slow/i },
  { name: "kw_security", re: /\bauth|认证|token|permission|权限|security|安全|login|登录/i },
  { name: "kw_ui",       re: /\bui\b|界面|\bcss\b|style|component|组件|\bpage|页面|frontend|前端/i },
  { name: "kw_data",     re: /\bdatabase|数据库|\bsql\b|query|migration|schema|\btable\b|mongo|\bredis/i },
]);

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
/** Task-type classification (matches baseline/estimator.mjs). */
const TASK_TYPES = ["skill", "refactor", "feature", "modify", "read", "simple"];

function classifyTaskType(prompt) {
  const d = (prompt || "").toLowerCase();
  if (/^\/[a-zA-Z0-9_-]/.test(d)) return "skill";
  if (/refactor|重构|rewrite|重写|migrate|迁移/.test(d)) return "refactor";
  if (/implement|实现|build|构建|create|创建|add feature|新功能/.test(d)) return "feature";
  if (/fix|修复|bug|error|报错|issue/.test(d)) return "modify";
  if (/read|看|explain|解释|what|how|为什么|分析|review/.test(d)) return "read";
  return "simple";
}

export { TASK_TYPES };

export function extractFeatures(task) {
  const prompt = task.user_prompt || "";
  const skill = task.skill_name || extractSkillName(prompt);
  const { hour, weekday } = timeFeatures(task.timestamp);

  // Keyword-group binary features
  const kwFeatures = {};
  for (const g of KEYWORD_GROUPS) {
    kwFeatures[g.name] = g.re.test(prompt) ? 1 : 0;
  }

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
    task_type: classifyTaskType(prompt),

    // keyword-group binary features (12 dims)
    ...kwFeatures,

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
