import { test } from "node:test";
import assert from "node:assert/strict";
import { mlpForward } from "../src/models/mlp.mjs";
import { linearPredict } from "../src/models/linear.mjs";
import { registerBackend, getBackend, listBackends } from "../src/models/registry.mjs";

// --- MLP forward pass tests ---

test("mlpForward computes BatchNorm → Linear → ReLU → Linear correctly", () => {
  const weights = {
    bn: {
      weight: [1, 1],
      bias: [0, 0],
      running_mean: [0, 0],
      running_var: [1, 1],
      eps: 1e-5,
    },
    layers: [
      // 3×2 hidden layer
      { weight: [[0.5, 0.5], [0.3, -0.3], [-0.1, 0.2]], bias: [0, 0, 0] },
      // 1×3 output
      { weight: [[1, 1, 1]], bias: [0.1] },
    ],
  };
  const x = new Float64Array([1, 2]);
  const result = mlpForward(x, weights);
  // Manual calc:
  // After BN (identity): [1, 2]
  // Layer 0: [0.5*1+0.5*2, 0.3*1-0.3*2, -0.1*1+0.2*2] = [1.5, -0.3, 0.3]
  // ReLU: [1.5, 0, 0.3]
  // Layer 1: [1*1.5+1*0+1*0.3] + 0.1 = [1.9]
  assert.ok(typeof result === "number");
  assert.ok(Math.abs(result - 1.9) < 1e-3, `expected ~1.9, got ${result}`);
});

test("mlpForward handles BatchNorm with non-trivial mean/var", () => {
  const weights = {
    bn: {
      weight: [2],
      bias: [1],
      running_mean: [5],
      running_var: [4],
      eps: 0,
    },
    layers: [
      { weight: [[1]], bias: [0] },
    ],
  };
  const x = new Float64Array([7]);
  const result = mlpForward(x, weights);
  // BN: (7-5)/sqrt(4) * 2 + 1 = 1*2+1 = 3
  // Layer: 1*3 + 0 = 3
  assert.ok(Math.abs(result - 3) < 1e-9, `expected 3, got ${result}`);
});

test("mlpForward returns a scalar (no array)", () => {
  const weights = {
    bn: { weight: [1], bias: [0], running_mean: [0], running_var: [1], eps: 1e-5 },
    layers: [{ weight: [[1]], bias: [0] }],
  };
  const result = mlpForward(new Float64Array([5]), weights);
  assert.equal(typeof result, "number");
});

// --- Linear predict tests ---

test("linearPredict computes dot product + intercept", () => {
  const w = { coef: [0.1, 0.2, 0.3], intercept: 0.5 };
  const x = new Float64Array([1, 2, 3]);
  const result = linearPredict(x, w);
  // 0.1*1 + 0.2*2 + 0.3*3 + 0.5 = 0.1+0.4+0.9+0.5 = 1.9
  assert.ok(Math.abs(result - 1.9) < 1e-9);
});

test("linearPredict handles zero weights", () => {
  const w = { coef: [0, 0, 0], intercept: 42 };
  const result = linearPredict(new Float64Array([1, 2, 3]), w);
  assert.equal(result, 42);
});

// --- Registry tests ---

test("registerBackend and getBackend round-trip", () => {
  registerBackend("test_model", { name: "test_model", load: async () => null });
  assert.ok(getBackend("test_model"));
  assert.equal(getBackend("test_model").name, "test_model");
  assert.ok(listBackends().includes("test_model"));
});

test("getBackend returns undefined for unregistered models", () => {
  assert.equal(getBackend("nonexistent_xyz"), undefined);
});
