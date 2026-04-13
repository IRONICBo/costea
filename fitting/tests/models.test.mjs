import { test } from "node:test";
import assert from "node:assert/strict";
import { empiricalPredict, attachTargets } from "../src/models/empirical.mjs";
import { IsotonicRegressor, fitIntervalCalibrator, applyIntervalCalibrator } from "../src/models/calibration.mjs";

test("attachTargets writes y_* fields", () => {
  const m = attachTargets({ source: "x" }, {
    token_usage: { input: 10, output: 20, cache_read: 30 },
    total_tool_calls: 5,
  }, () => 0.42);
  assert.equal(m.y_input, 10);
  assert.equal(m.y_output, 20);
  assert.equal(m.y_cache_read, 30);
  assert.equal(m.y_tools, 5);
  assert.equal(m.y_cost, 0.42);
});

test("empiricalPredict yields p10 ≤ p50 ≤ p90 in raw units", () => {
  const neighbours = [10, 100, 1000, 10000, 100000].map((v, i) => ({
    score: 1 - i * 0.1,
    sim: 1 - i * 0.1,
    boost: 0,
    meta: {
      y_input: v, y_output: v / 5, y_cache_read: v * 2,
      y_tools: 5, y_cost: v / 1000,
    },
  }));
  const r = empiricalPredict(neighbours);
  assert.ok(r.ok);
  for (const tgt of ["input", "output", "cache_read", "cost"]) {
    const p = r.predictions[tgt];
    assert.ok(p.p10 <= p.p50 + 1e-9, `${tgt} p10>p50`);
    assert.ok(p.p50 <= p.p90 + 1e-9, `${tgt} p50>p90`);
  }
});

test("empiricalPredict refuses to fire below minNeighbours", () => {
  const r = empiricalPredict([], { minNeighbours: 1 });
  assert.equal(r.ok, false);
});

test("IsotonicRegressor enforces monotonicity by pooling", () => {
  // input is decreasing in y → PAV should pool everything
  const iso = new IsotonicRegressor().fit([1, 2, 3], [10, 8, 5]);
  // Should collapse to one block with mean (10+8+5)/3 ≈ 7.667
  assert.equal(iso.ys.length, 1);
  assert.ok(Math.abs(iso.ys[0] - (10 + 8 + 5) / 3) < 1e-9);
});

test("IsotonicRegressor preserves already-monotone input", () => {
  const iso = new IsotonicRegressor().fit([1, 2, 3], [1, 2, 3]);
  assert.deepEqual(iso.xs, [1, 2, 3]);
  assert.deepEqual(iso.ys, [1, 2, 3]);
});

test("IsotonicRegressor predict clamps and interpolates", () => {
  const iso = new IsotonicRegressor().fit([1, 3], [10, 30]);
  assert.equal(iso.predict(0), 10);   // below range
  assert.equal(iso.predict(2), 20);   // midpoint
  assert.equal(iso.predict(99), 30);  // above range
});

test("fitIntervalCalibrator widens too-tight intervals", () => {
  const preds = [];
  const acts = [];
  for (let i = 0; i < 100; i++) {
    const a = 10 + i;
    preds.push({ p10: a, p50: a, p90: a }); // zero-width
    acts.push(a + (i % 3 - 1) * 5);
  }
  const cal = fitIntervalCalibrator(preds, acts, { targetCoverage: 0.8 });
  assert.ok(cal.widthFactor >= 1);
  assert.ok(cal.coverageAfter >= cal.coverageBefore);
});

test("applyIntervalCalibrator preserves shape and never returns negatives for positives", () => {
  const cal = {
    p50: new IsotonicRegressor().fit([1, 2], [1, 2]),
    widthFactor: 1.5,
  };
  const out = applyIntervalCalibrator(cal, { p10: 5, p50: 10, p90: 20 });
  assert.ok(out.p10 < out.p50);
  assert.ok(out.p50 < out.p90);
  assert.ok(out.p10 >= 0);
});
