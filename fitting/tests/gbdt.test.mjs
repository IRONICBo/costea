import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";
import { existsSync } from "node:fs";
import { parseLightgbmText, predict, predictBundle, loadLightgbmText } from "../src/models/gbdt.mjs";
import { loadBundle, defaultModelsDir } from "../src/models/bundle.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

const FIXTURE_TREE = `tree
version=v4
num_class=1
num_tree_per_iteration=1
label_index=0
max_feature_idx=1
objective=regression
feature_names=x0 x1
feature_infos=none none
tree_sizes=120

Tree=0
num_leaves=3
num_cat=0
split_feature=0 1
split_gain=10 5
threshold=0.5 1.5
decision_type=2 2
left_child=1 -1
right_child=-2 -3
leaf_value=10 20 30

end of trees
`;

test("parseLightgbmText handles a hand-crafted minimal model", () => {
  const m = parseLightgbmText(FIXTURE_TREE);
  assert.equal(m.objective, "regression");
  assert.deepEqual(m.feature_names, ["x0", "x1"]);
  assert.equal(m.trees.length, 1);
  assert.equal(m.trees[0].leaf_value.length, 3);
});

test("predict walks the right path through internal nodes to the right leaf", () => {
  const m = parseLightgbmText(FIXTURE_TREE);
  // node 0: x0 ≤ 0.5 → node 1, else leaf -2 (value 20)
  // node 1: x1 ≤ 1.5 → leaf -1 (value 10), else leaf -3 (value 30)
  assert.equal(predict(m, [0.4, 1.0]), 10);
  assert.equal(predict(m, [0.4, 2.0]), 30);
  assert.equal(predict(m, [0.7, 0.0]), 20);
});

test("predict handles a single-leaf tree", () => {
  const text = `tree
version=v4
num_class=1
max_feature_idx=0
objective=regression
feature_names=x0
feature_infos=none
tree_sizes=10

Tree=0
num_leaves=1
num_cat=0
leaf_value=42

end of trees
`;
  const m = parseLightgbmText(text);
  assert.equal(predict(m, [99]), 42);
});

test("predict respects default-left for missing values", () => {
  // decision_type 3 = bit 0 (default-left) + bit 1 (categorical, ignored here)
  // We test decision_type 1 (default-left) so missing goes to left child.
  const text = `tree
version=v4
num_class=1
max_feature_idx=0
objective=regression
feature_names=x0
feature_infos=none
tree_sizes=10

Tree=0
num_leaves=2
num_cat=0
split_feature=0
split_gain=1
threshold=10
decision_type=1
left_child=-1
right_child=-2
leaf_value=100 200

end of trees
`;
  const m = parseLightgbmText(text);
  assert.equal(predict(m, [NaN]), 100, "missing value goes left when default-left bit set");
  assert.equal(predict(m, [5]), 100);
  assert.equal(predict(m, [50]), 200);
});

// The bundled demo weights ship in fitting/models/. Skip the suite if
// somebody trimmed them.
const BUNDLE_DIR = defaultModelsDir();
const BUNDLE_PRESENT = existsSync(path.join(BUNDLE_DIR, "manifest.json"));

test("loadBundle parses the bundled demo manifest + every head", { skip: !BUNDLE_PRESENT }, async () => {
  const b = await loadBundle();
  assert.ok(b);
  assert.equal(b.manifest.feature_names.length, 47);
  for (const tgt of b.manifest.targets) {
    assert.ok(b.heads[tgt].p10);
    assert.ok(b.heads[tgt].p50);
    assert.ok(b.heads[tgt].p90);
    assert.ok(b.heads[tgt].p50.trees.length > 0);
  }
});

test("predictBundle returns monotone (p10 ≤ p50 ≤ p90) and non-negative", { skip: !BUNDLE_PRESENT }, async () => {
  const b = await loadBundle();
  const x = new Float64Array(47);  // all-zero feature row
  const out = predictBundle(b, x);
  for (const tgt of b.manifest.targets) {
    assert.ok(out[tgt].p10 <= out[tgt].p50 + 1e-9, `${tgt} p10>p50`);
    assert.ok(out[tgt].p50 <= out[tgt].p90 + 1e-9, `${tgt} p50>p90`);
    assert.ok(out[tgt].p10 >= 0, `${tgt} negative`);
  }
});

test("loadBundle returns null for a missing directory (no throw)", async () => {
  const b = await loadBundle("/tmp/__definitely_not_a_costea_models_dir__");
  assert.equal(b, null);
});

test("loadLightgbmText round-trips a written file", async () => {
  const fixturePath = path.join(HERE, "_fixture_tree.txt");
  const fs = await import("node:fs/promises");
  await fs.writeFile(fixturePath, FIXTURE_TREE, "utf-8");
  try {
    const m = await loadLightgbmText(fixturePath);
    assert.equal(m.trees.length, 1);
    assert.equal(predict(m, [0.4, 1.0]), 10);
  } finally {
    await fs.unlink(fixturePath);
  }
});
