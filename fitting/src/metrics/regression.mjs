/**
 * Pointwise regression metrics. All operate on parallel arrays of
 * actual / predicted values; missing or non-finite values are dropped
 * pairwise.
 */

function pairs(actual, predicted) {
  const out = [];
  const n = Math.min(actual.length, predicted.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i], p = predicted[i];
    if (Number.isFinite(a) && Number.isFinite(p)) out.push([a, p]);
  }
  return out;
}

/** Mean Absolute Percentage Error. Returns a fraction (0.4 = 40%). */
export function mape(actual, predicted, { eps = 1 } = {}) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  let sum = 0;
  for (const [a, p] of ps) {
    sum += Math.abs(a - p) / Math.max(Math.abs(a), eps);
  }
  return sum / ps.length;
}

/** Median Absolute Percentage Error — far more robust to outliers. */
export function medianAPE(actual, predicted, { eps = 1 } = {}) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  const errs = ps.map(([a, p]) => Math.abs(a - p) / Math.max(Math.abs(a), eps));
  errs.sort((a, b) => a - b);
  const m = Math.floor(errs.length / 2);
  return errs.length % 2 ? errs[m] : (errs[m - 1] + errs[m]) / 2;
}

/** Root Mean Squared Error in raw units. */
export function rmse(actual, predicted) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  let sum = 0;
  for (const [a, p] of ps) sum += (a - p) ** 2;
  return Math.sqrt(sum / ps.length);
}

/** RMSE in log1p space — the natural error scale for heavy-tailed targets. */
export function logRMSE(actual, predicted) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  let sum = 0;
  for (const [a, p] of ps) {
    const la = Math.log1p(Math.max(0, a));
    const lp = Math.log1p(Math.max(0, p));
    sum += (la - lp) ** 2;
  }
  return Math.sqrt(sum / ps.length);
}

/** Bias = mean(predicted - actual). Positive => over-estimating. */
export function bias(actual, predicted) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  let sum = 0;
  for (const [a, p] of ps) sum += p - a;
  return sum / ps.length;
}

/** Fraction of predictions within ±tol of actual (relative). */
export function withinTolerance(actual, predicted, tol = 0.25, { eps = 1 } = {}) {
  const ps = pairs(actual, predicted);
  if (ps.length === 0) return null;
  let hit = 0;
  for (const [a, p] of ps) {
    if (Math.abs(a - p) / Math.max(Math.abs(a), eps) <= tol) hit++;
  }
  return hit / ps.length;
}

/** Convenience bundle. */
export function summarize(actual, predicted, label = "") {
  return {
    label,
    n: pairs(actual, predicted).length,
    mape: mape(actual, predicted),
    median_ape: medianAPE(actual, predicted),
    rmse: rmse(actual, predicted),
    log_rmse: logRMSE(actual, predicted),
    bias: bias(actual, predicted),
    within_25pct: withinTolerance(actual, predicted, 0.25),
    within_50pct: withinTolerance(actual, predicted, 0.5),
  };
}
