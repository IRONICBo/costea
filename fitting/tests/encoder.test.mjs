import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_NAMES,
  defaultManifest,
  encodeFeatures,
  encodeQuery,
  collectSkills,
} from "../src/features/encoder.mjs";

test("FEATURE_NAMES has 47 columns: 18 original + 1 task_type + 12 kw + 16 svd", () => {
  assert.equal(FEATURE_NAMES.length, 47);
  // First five are prompt-shape; categorical lookups at 14-17.
  assert.equal(FEATURE_NAMES[0], "prompt_chars");
  assert.equal(FEATURE_NAMES[5], "is_skill");
  assert.equal(FEATURE_NAMES[14], "lang_idx");
  assert.equal(FEATURE_NAMES[17], "skill_idx");
  // New features
  assert.equal(FEATURE_NAMES[18], "task_type_idx");
  assert.equal(FEATURE_NAMES[19], "kw_test");
  assert.equal(FEATURE_NAMES[30], "kw_data");
  assert.equal(FEATURE_NAMES[31], "svd_0");
  assert.equal(FEATURE_NAMES[46], "svd_15");
});

test("defaultManifest exposes the canonical schema", () => {
  const m = defaultManifest(["qa", "ship"]);
  assert.equal(m.feature_names.length, 47);
  assert.deepEqual(m.targets, ["input", "output", "cache_read", "tools", "cost"]);
  assert.deepEqual(m.quantiles, [0.1, 0.5, 0.9]);
  assert.ok(m.categorical.source.includes("claude-code"));
  assert.deepEqual(m.categorical.skill, ["qa", "ship"]);
  assert.deepEqual(m.categorical.task_type, ["skill", "refactor", "feature", "modify", "read", "simple"]);
  assert.equal(m.svd_dims, 16);
});

test("encodeFeatures produces a Float64Array in canonical order (47 dims)", () => {
  const m = defaultManifest(["qa"]);
  const f = {
    prompt_chars: 100, prompt_words: 10, prompt_approx_tokens: 25,
    prompt_has_code: 1, prompt_file_path_count: 2,
    is_skill: 1, skill_name: "qa",
    source: "claude-code", model: "claude-sonnet-4-6",
    task_type: "skill",
    kw_test: 1, kw_refactor: 0, kw_fix: 0, kw_create: 0, kw_read: 0,
    kw_deploy: 0, kw_doc: 0, kw_config: 0, kw_perf: 0, kw_security: 0,
    kw_ui: 0, kw_data: 0,
    turn_index: 3, is_first_turn: 0,
    prior_session_input: 1000, prior_session_output: 200,
    prior_session_cache_read: 5000, prior_session_total: 6200,
    hour_of_day: 14, weekday: 1, prompt_lang: "latin",
  };
  const x = encodeFeatures(f, m, "");
  assert.equal(x.length, 47);
  assert.equal(x[0], 100);
  assert.equal(x[5], 1);             // is_skill
  assert.equal(x[14], 0);            // lang_idx → "latin" is index 0
  assert.equal(x[15], 0);            // source_idx → "claude-code" is index 0
  assert.equal(x[16], 1);            // model_idx → "claude-sonnet-4-6" is index 1
  assert.equal(x[17], 0);            // skill_idx → "qa" is index 0 in skill vocab
  assert.equal(x[18], 0);            // task_type_idx → "skill" is index 0
  assert.equal(x[19], 1);            // kw_test = 1
  assert.equal(x[20], 0);            // kw_refactor = 0
  // SVD features (31..46) are zeros because manifest has no svd_components
  assert.equal(x[31], 0);
  assert.equal(x[46], 0);
});

test("encodeFeatures emits -1 for unknown categories", () => {
  const m = defaultManifest([]);
  const f = {
    prompt_chars: 0, prompt_words: 0, prompt_approx_tokens: 0,
    prompt_has_code: 0, prompt_file_path_count: 0,
    is_skill: 0, skill_name: "never-seen",
    source: "made-up-source", model: "made-up-model",
    task_type: "simple",
    kw_test: 0, kw_refactor: 0, kw_fix: 0, kw_create: 0, kw_read: 0,
    kw_deploy: 0, kw_doc: 0, kw_config: 0, kw_perf: 0, kw_security: 0,
    kw_ui: 0, kw_data: 0,
    turn_index: 0, is_first_turn: 1,
    prior_session_input: 0, prior_session_output: 0,
    prior_session_cache_read: 0, prior_session_total: 0,
    hour_of_day: 0, weekday: 0, prompt_lang: "klingon",
  };
  const x = encodeFeatures(f, m, "");
  assert.equal(x[14], -1);  // lang_idx
  assert.equal(x[15], -1);  // source_idx
  assert.equal(x[16], -1);  // model_idx
  assert.equal(x[17], -1);  // skill_idx
});

test("encodeQuery threads ctx into session-position features", () => {
  const m = defaultManifest([]);
  const x = encodeQuery("/qa run all tests", {
    source: "claude-code",
    turn_index: 7,
    prior_session_total: 50000,
  }, m);
  assert.equal(x[5], 1);  // is_skill (slash-prefixed)
  assert.equal(x[6], 7);  // turn_index
  assert.equal(x[7], 0);  // is_first_turn
  assert.equal(x[11], 50000);  // prior_session_total
});

test("collectSkills dedupes, sorts, and skips null", () => {
  const tasks = [
    { skill_name: "qa" }, { skill_name: "ship" }, { skill_name: "qa" },
    { skill_name: null }, { skill_name: "commit" },
  ];
  assert.deepEqual(collectSkills(tasks), ["commit", "qa", "ship"]);
});
