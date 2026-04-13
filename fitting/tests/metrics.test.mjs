import { test } from "node:test";
import assert from "node:assert/strict";
import { mape, medianAPE, rmse, logRMSE, bias, withinTolerance, summarize } from "../src/metrics/regression.mjs";
import { coverage, meanWidth, intervalScore } from "../src/metrics/coverage.mjs";

test("mape on simple inputs", () => {
  // |1-1|/max(1,1) + |2-3|/max(2,1) = 0 + 0.5 → mean 0.25
  const m = mape([1, 2], [1, 3]);
  assert.equal(m, 0.25);
});

test("medianAPE drops to median, not mean", () => {
  // errors: 0, 0.5, 100 → median 0.5
  const m = medianAPE([1, 2, 1], [1, 3, 101]);
  assert.equal(m, 0.5);
});

test("rmse and logRMSE compute correctly", () => {
  assert.equal(rmse([0, 0, 0], [1, 1, 1]), 1);
  // log1p(0)=0, log1p(e^1 - 1)=1 → diff 1, mean 1, sqrt 1
  const v = Math.exp(1) - 1;
  assert.ok(Math.abs(logRMSE([0, 0], [v, v]) - 1) < 1e-9);
});

test("bias direction is predicted - actual", () => {
  assert.equal(bias([10, 10], [12, 14]), 3);  // overestimate => positive
  assert.equal(bias([10, 10], [8, 6]), -3);
});

test("withinTolerance counts hits", () => {
  // |10-12|/10 = 0.2 (in), |10-14|/10 = 0.4 (out at tol 0.25)
  assert.equal(withinTolerance([10, 10], [12, 14], 0.25), 0.5);
});

test("summarize bundles everything without throwing on empty", () => {
  const s = summarize([], [], "empty");
  assert.equal(s.n, 0);
  assert.equal(s.mape, null);
});

test("coverage hits the full interval", () => {
  const intervals = [{ p10: 0, p50: 5, p90: 10 }, { p10: 0, p50: 5, p90: 3 }];
  // actual 5 in [0,10], actual 5 NOT in [0,3]
  assert.equal(coverage([5, 5], intervals), 0.5);
});

test("intervalScore penalises misses heavier than width", () => {
  // narrow interval, big miss
  const narrow = [{ p10: 5, p50: 5, p90: 5 }];
  const wide = [{ p10: 0, p50: 5, p90: 10 }];
  const a = [20];
  // narrow: width 0, penalty (2/0.2)*(20-5) = 150 → score 150
  // wide:   width 10, penalty (2/0.2)*(20-10) = 100 → score 110
  assert.ok(intervalScore(a, narrow) > intervalScore(a, wide));
});

test("meanWidth ignores broken intervals", () => {
  const intervals = [{ p10: 0, p50: 5, p90: 10 }, null, { p10: 1, p50: 2, p90: 3 }];
  assert.equal(meanWidth(intervals), (10 + 2) / 2);
});
