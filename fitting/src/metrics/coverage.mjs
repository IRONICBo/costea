/**
 * Interval-prediction metrics. Inputs are arrays of {p10, p50, p90}
 * objects matched against an actual[] array.
 */

/**
 * Coverage = fraction of actuals that fall within [p10, p90].
 * Well-calibrated 80% intervals should give ~0.80.
 */
export function coverage(actual, intervals) {
  if (actual.length !== intervals.length) {
    throw new Error("actual/intervals length mismatch");
  }
  let n = 0, hit = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const iv = intervals[i];
    if (!Number.isFinite(a) || !iv || !Number.isFinite(iv.p10) || !Number.isFinite(iv.p90)) continue;
    n++;
    if (a >= iv.p10 && a <= iv.p90) hit++;
  }
  return n === 0 ? null : hit / n;
}

/** Mean width of the [p10, p90] interval. Useful as a sharpness check. */
export function meanWidth(intervals) {
  let sum = 0, n = 0;
  for (const iv of intervals) {
    if (!iv || !Number.isFinite(iv.p10) || !Number.isFinite(iv.p90)) continue;
    sum += iv.p90 - iv.p10;
    n++;
  }
  return n === 0 ? null : sum / n;
}

/**
 * Winkler interval score (lower = better). Penalises both width and
 * miscoverage; α=0.2 corresponds to the 80% interval.
 *
 * IS_α(L,U,a) = (U-L) + (2/α)(L-a) if a<L, + (2/α)(a-U) if a>U, else just U-L
 */
export function intervalScore(actual, intervals, alpha = 0.2) {
  if (actual.length !== intervals.length) {
    throw new Error("actual/intervals length mismatch");
  }
  let sum = 0, n = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const iv = intervals[i];
    if (!Number.isFinite(a) || !iv || !Number.isFinite(iv.p10) || !Number.isFinite(iv.p90)) continue;
    n++;
    const L = iv.p10, U = iv.p90;
    let s = U - L;
    if (a < L) s += (2 / alpha) * (L - a);
    else if (a > U) s += (2 / alpha) * (a - U);
    sum += s;
  }
  return n === 0 ? null : sum / n;
}

/** Quick bundle for reports. */
export function summarizeIntervals(actual, intervals, label = "") {
  return {
    label,
    n: actual.length,
    coverage_p10_p90: coverage(actual, intervals),
    mean_width: meanWidth(intervals),
    interval_score: intervalScore(actual, intervals, 0.2),
  };
}
