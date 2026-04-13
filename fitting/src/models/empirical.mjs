/**
 * Empirical quantile regressor over kNN neighbours.
 *
 * Given the top-K hits from KnnIndex (each carrying its own y_actual),
 * compute weighted P10 / P50 / P90 in **log1p space** then exp1m back.
 *
 * Why log space:
 *   token usage spans ~6 orders of magnitude in the corpus. Linear
 *   averaging is dominated by the largest neighbour. Log-space gives
 *   the geometric centre of mass, which matches our heavy-tail prior.
 *
 * Why empirical (vs analytical) quantiles:
 *   K is small (5–10). Distributional assumptions are unjustified;
 *   we just sort and pick. With weights we use the inverse-CDF on the
 *   weighted ECDF.
 */

const KEYS = ["input", "output", "cache_read", "tools", "cost"];

/** Weighted quantile via the inverse CDF on a sorted weighted sample. */
function weightedQuantile(values, weights, p) {
  if (values.length === 0) return null;
  const pairs = values
    .map((v, i) => [v, weights[i]])
    .filter(([v, w]) => Number.isFinite(v) && w > 0)
    .sort((a, b) => a[0] - b[0]);
  if (pairs.length === 0) return null;
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc / total >= p) return v;
  }
  return pairs[pairs.length - 1][0];
}

function targetsFromNeighbour(meta) {
  // Targets are read off the meta we attached at index time. Keep a
  // single source of truth so callers can bring whatever shape they
  // like by populating these fields.
  return {
    input: meta.y_input ?? 0,
    output: meta.y_output ?? 0,
    cache_read: meta.y_cache_read ?? 0,
    tools: meta.y_tools ?? 0,
    cost: meta.y_cost ?? 0,
  };
}

/**
 * Predict {p10, p50, p90} for each of {input, output, cache_read, tools, cost}.
 *
 * @param {Array<{score:number, sim:number, boost:number, meta:Object}>} neighbours
 * @param {{quantiles?:[number,number,number], minNeighbours?:number}} opts
 * @returns {Object} keyed prediction with .meta.method etc.
 */
export function empiricalPredict(neighbours, opts = {}) {
  const [pLo, pMid, pHi] = opts.quantiles ?? [0.1, 0.5, 0.9];
  const minN = opts.minNeighbours ?? 1;

  if (neighbours.length < minN) {
    return { ok: false, reason: "not_enough_neighbours", neighbour_count: neighbours.length };
  }

  // Use score (cosine + metadata boost) as the weight, floored so a
  // single near-zero hit can't dominate the geometric mean.
  const weights = neighbours.map((n) => Math.max(n.score, 0.05));

  const out = { ok: true, neighbour_count: neighbours.length, predictions: {} };
  for (const key of KEYS) {
    const logVals = neighbours.map((n) => Math.log1p(Math.max(0, targetsFromNeighbour(n.meta)[key])));
    const lp10 = weightedQuantile(logVals, weights, pLo);
    const lp50 = weightedQuantile(logVals, weights, pMid);
    const lp90 = weightedQuantile(logVals, weights, pHi);
    out.predictions[key] = {
      p10: lp10 === null ? null : Math.expm1(lp10),
      p50: lp50 === null ? null : Math.expm1(lp50),
      p90: lp90 === null ? null : Math.expm1(lp90),
    };
  }

  // Heuristic confidence based on neighbour quality. Top-3 mean score
  // is in [0,1.x] thanks to boosts; clamp to 0..1 then map to [40,95].
  const top3 = neighbours.slice(0, 3);
  const avgTop3 = top3.reduce((s, n) => s + n.score, 0) / top3.length;
  const conf = Math.round(40 + Math.min(1, avgTop3) * 55);
  out.confidence = conf;

  return out;
}

/** Attach actual y values onto a meta record so empiricalPredict can read them. */
export function attachTargets(meta, task, costFn) {
  return {
    ...meta,
    y_input: task.token_usage.input || 0,
    y_output: task.token_usage.output || 0,
    y_cache_read: task.token_usage.cache_read || 0,
    y_tools: task.total_tool_calls || 0,
    y_cost: costFn ? costFn(task) : 0,
  };
}
