/**
 * Calibration layer.
 *
 * Two related but separable concerns:
 *
 * 1. **Isotonic regression** on (predicted P50, actual) pairs from the
 *    validation set — corrects systematic over/under-estimation
 *    without enforcing a parametric form. Implemented with the classic
 *    pool-adjacent-violators (PAV) algorithm.
 *
 * 2. **Conformal width adjustment** for the [P10, P90] interval —
 *    measures how often the actual fell outside the predicted interval
 *    on the validation set, and computes a multiplicative widening
 *    factor that would have hit the target coverage. Cheap, simple,
 *    and avoids the need to retrain quantile heads.
 *
 * Both calibrators are fit in **log1p space** (consistent with the
 * empirical regressor's representation) so we don't need to re-derive
 * scaling laws.
 */

/** Pool-adjacent-violators isotonic regression. */
export class IsotonicRegressor {
  constructor() {
    /** @type {number[]} sorted ascending */
    this.xs = [];
    /** @type {number[]} parallel to xs */
    this.ys = [];
  }

  /**
   * @param {number[]} xs predicted (any scale)
   * @param {number[]} ys actual (same scale)
   */
  fit(xs, ys) {
    if (xs.length !== ys.length) throw new Error("xs/ys length mismatch");
    const pairs = xs.map((x, i) => [x, ys[i]])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .sort((a, b) => a[0] - b[0]);
    if (pairs.length === 0) {
      this.xs = []; this.ys = [];
      return this;
    }

    // PAV: iterate left→right, pool violating blocks until monotone.
    const blocks = pairs.map(([x, y]) => ({ sumX: x, sumY: y, n: 1, meanY: y }));
    let i = 0;
    while (i < blocks.length - 1) {
      if (blocks[i].meanY <= blocks[i + 1].meanY) {
        i++;
      } else {
        // Merge i and i+1.
        const merged = {
          sumX: blocks[i].sumX + blocks[i + 1].sumX,
          sumY: blocks[i].sumY + blocks[i + 1].sumY,
          n: blocks[i].n + blocks[i + 1].n,
        };
        merged.meanY = merged.sumY / merged.n;
        blocks.splice(i, 2, merged);
        // Step back to re-check the previous block.
        if (i > 0) i--;
      }
    }

    this.xs = blocks.map((b) => b.sumX / b.n);
    this.ys = blocks.map((b) => b.meanY);
    return this;
  }

  /** Piecewise-linear interpolation; clamp at the ends. */
  predict(x) {
    if (this.xs.length === 0) return x;
    if (this.xs.length === 1) return this.ys[0];
    if (x <= this.xs[0]) return this.ys[0];
    if (x >= this.xs[this.xs.length - 1]) return this.ys[this.ys.length - 1];
    // Binary search for the right segment.
    let lo = 0, hi = this.xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.xs[mid] <= x) lo = mid; else hi = mid;
    }
    const dx = this.xs[hi] - this.xs[lo];
    if (dx === 0) return (this.ys[lo] + this.ys[hi]) / 2;
    const t = (x - this.xs[lo]) / dx;
    return this.ys[lo] + t * (this.ys[hi] - this.ys[lo]);
  }

  toJSON() { return { xs: this.xs, ys: this.ys }; }
  static fromJSON(o) {
    const r = new IsotonicRegressor();
    r.xs = [...o.xs]; r.ys = [...o.ys];
    return r;
  }
}

/**
 * Calibrate a {p10, p50, p90} predictor against a validation set.
 *
 * @param {Array<{p10:number,p50:number,p90:number}>} preds
 * @param {number[]} actuals
 * @param {{targetCoverage?:number, maxWiden?:number}} opts
 * @returns {{p50: IsotonicRegressor, widthFactor: number, coverageBefore: number, coverageAfter: number}}
 */
export function fitIntervalCalibrator(preds, actuals, opts = {}) {
  const target = opts.targetCoverage ?? 0.8;
  const maxWiden = opts.maxWiden ?? 4;

  // Fit isotonic on (P50, actual) in log1p space.
  const xs = preds.map((p) => Math.log1p(Math.max(0, p.p50)));
  const ys = actuals.map((a) => Math.log1p(Math.max(0, a)));
  const iso = new IsotonicRegressor().fit(xs, ys);

  // Measure pre-calibration coverage.
  let inside = 0, total = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i], a = actuals[i];
    if (!p || !Number.isFinite(a)) continue;
    total++;
    if (a >= p.p10 && a <= p.p90) inside++;
  }
  const coverageBefore = total === 0 ? null : inside / total;

  // Conformal width: find multiplicative factor in log space that
  // hits target coverage. Searches a coarse grid then refines.
  function coverageAtFactor(f) {
    let in_ = 0, n = 0;
    for (let i = 0; i < preds.length; i++) {
      const p = preds[i], a = actuals[i];
      if (!p || !Number.isFinite(a)) continue;
      const lp50 = Math.log1p(Math.max(0, p.p50));
      const lp10 = Math.log1p(Math.max(0, p.p10));
      const lp90 = Math.log1p(Math.max(0, p.p90));
      const widenedLo = lp50 - (lp50 - lp10) * f;
      const widenedHi = lp50 + (lp90 - lp50) * f;
      const la = Math.log1p(Math.max(0, a));
      n++;
      if (la >= widenedLo && la <= widenedHi) in_++;
    }
    return n === 0 ? 0 : in_ / n;
  }

  let bestFactor = 1, bestDist = Math.abs(coverageBefore - target);
  for (let f = 0.5; f <= maxWiden + 1e-9; f += 0.1) {
    const c = coverageAtFactor(f);
    const d = Math.abs(c - target);
    if (d < bestDist) { bestDist = d; bestFactor = f; }
  }

  return {
    p50: iso,
    widthFactor: Math.round(bestFactor * 10) / 10,
    coverageBefore,
    coverageAfter: coverageAtFactor(bestFactor),
  };
}

/** Apply a calibrator to one prediction. Returns a new {p10,p50,p90}. */
export function applyIntervalCalibrator(calib, pred) {
  if (!pred) return pred;
  const lp50 = Math.log1p(Math.max(0, pred.p50));
  const lp10 = Math.log1p(Math.max(0, pred.p10));
  const lp90 = Math.log1p(Math.max(0, pred.p90));
  const calLp50 = calib.p50.predict(lp50);
  // Preserve the original interval shape (asymmetric is fine), then widen.
  const lo = calLp50 - (lp50 - lp10) * calib.widthFactor;
  const hi = calLp50 + (lp90 - lp50) * calib.widthFactor;
  return {
    p10: Math.expm1(lo),
    p50: Math.expm1(calLp50),
    p90: Math.expm1(hi),
  };
}
