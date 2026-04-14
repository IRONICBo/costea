/**
 * Port of `web/src/lib/estimator.ts` — the current production heuristic.
 *
 * Lives here so we can evaluate it on the same time-split test set as
 * the ML methods, without spinning up the Next.js stack. Logic mirrors
 * the four strategies (weighted_similar / blend / recent_p90_30d /
 * hardcoded_baseline) verbatim.
 */

const BASELINES = {
  simple:   { input: 8000,   output: 2000,   tools: 3 },
  read:     { input: 35000,  output: 5000,   tools: 8 },
  modify:   { input: 50000,  output: 10000,  tools: 15 },
  skill:    { input: 120000, output: 30000,  tools: 30 },
  refactor: { input: 250000, output: 50000,  tools: 50 },
  feature:  { input: 500000, output: 100000, tools: 80 },
};

export function classifyTask(desc) {
  const d = (desc || "").toLowerCase();
  if (/^\/[a-zA-Z0-9_-]/.test(d)) return "skill";
  if (/refactor|重构|rewrite|重写|migrate|迁移/.test(d)) return "refactor";
  if (/implement|实现|build|构建|create|创建|add feature|新功能/.test(d)) return "feature";
  if (/fix|修复|bug|error|报错|issue/.test(d)) return "modify";
  if (/read|看|explain|解释|what|how|为什么|分析|review/.test(d)) return "read";
  return "simple";
}

function tokens(s) {
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim().split(/\s+/).filter(Boolean)
  );
}

export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  const denom = Math.max(A.size, B.size);
  if (denom === 0) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / denom;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

/**
 * Run the existing four-strategy estimator against a candidate history.
 *
 * @param {string} taskDesc
 * @param {import("../data/loader.mjs").Task[]} history
 *        Candidate history pool (must NOT include the task being predicted).
 * @param {Date} [now]
 *        Reference timestamp for the 30-day P90 fallback. Default = max(history.timestamp).
 */
export function estimate(taskDesc, history, now) {
  const taskType = classifyTask(taskDesc);
  const baseline = BASELINES[taskType];

  // Score similar tasks.
  const skillName = taskDesc.startsWith("/") ? taskDesc.split(/\s/)[0].slice(1) : null;
  const scored = history
    .filter((t) => (t.token_usage?.total || 0) > 0)
    .map((t) => {
      const sim = similarity(taskDesc, t.user_prompt || "");
      const skillBoost = (t.is_skill && skillName && t.skill_name === skillName) ? 0.5 : 0;
      return { t, score: sim + skillBoost };
    })
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let estInput, estOutput, estCacheRead, estTools, method, confidence;

  if (scored.length >= 3) {
    method = "weighted_similar";
    const top = scored.slice(0, 5);
    const totalW = top.reduce((s, x) => s + x.score, 0);
    estInput = Math.round(top.reduce((s, x) => s + (x.t.token_usage.input || 0) * x.score, 0) / totalW);
    estOutput = Math.round(top.reduce((s, x) => s + (x.t.token_usage.output || 0) * x.score, 0) / totalW);
    estCacheRead = Math.round(top.reduce((s, x) => s + (x.t.token_usage.cache_read || 0) * x.score, 0) / totalW);
    estTools = Math.round(top.reduce((s, x) => s + (x.t.total_tool_calls || 0) * x.score, 0) / totalW);
    confidence = Math.min(98, 70 + Math.min(scored.length, 5) * 5 + Math.round(scored[0].score * 0.1));
  } else if (scored.length > 0) {
    method = "blend_match_baseline";
    const best = scored[0].t;
    estInput = Math.round(((best.token_usage.input || 0) + baseline.input) / 2);
    estOutput = Math.round(((best.token_usage.output || 0) + baseline.output) / 2);
    estCacheRead = Math.round((best.token_usage.cache_read || 0) / 2);
    estTools = Math.round(((best.total_tool_calls || 0) + baseline.tools) / 2);
    confidence = 50 + scored.length * 10;
  } else {
    // Try recent P90 fallback.
    const ref = now ? now.getTime()
      : history.length > 0 ? Math.max(...history.map((t) => Date.parse(t.timestamp) || 0))
      : Date.now();
    const cutoff = ref - 30 * 24 * 3600 * 1000;
    const recent = history.filter(
      (t) => (t.token_usage?.total || 0) > 0 && (Date.parse(t.timestamp) || 0) >= cutoff
    );
    if (recent.length >= 5) {
      method = "recent_p90_30d";
      estInput = percentile(recent.map((t) => t.token_usage.input || 0), 0.9);
      estOutput = percentile(recent.map((t) => t.token_usage.output || 0), 0.9);
      estCacheRead = percentile(recent.map((t) => t.token_usage.cache_read || 0), 0.9);
      estTools = percentile(recent.map((t) => t.total_tool_calls || 0), 0.9);
      confidence = 45;
    } else {
      method = "hardcoded_baseline";
      estInput = baseline.input;
      estOutput = baseline.output;
      estCacheRead = 0;
      estTools = baseline.tools;
      confidence = 35;
    }
  }

  return {
    method,
    task_type: taskType,
    confidence,
    similar_count: scored.length,
    input: estInput,
    output: estOutput,
    cache_read: estCacheRead,
    tool_calls: estTools,
    total: estInput + estOutput + estCacheRead,
  };
}
