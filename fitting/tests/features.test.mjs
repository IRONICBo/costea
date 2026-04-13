import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, extractQueryFeatures, detectLang, approxTokenCount } from "../src/features/extract.mjs";

test("detectLang labels CJK vs latin", () => {
  assert.equal(detectLang("hello world"), "latin");
  assert.equal(detectLang("你好世界"), "cjk");
  assert.equal(detectLang("hello 你好"), "latin"); // tie-broken by majority — 5 ascii > 2 cjk
  assert.equal(detectLang(""), "unknown");
});

test("approxTokenCount roughly matches 4 ascii / 1.7 cjk per token", () => {
  // 8 ascii chars → 8/4 = 2 tokens
  assert.equal(approxTokenCount("abcdefgh"), 2);
  // 4 cjk chars → ~2 tokens (rounded)
  assert.equal(approxTokenCount("你好世界"), 2);
});

test("extractFeatures pulls skill_name from /-prefixed prompt", () => {
  const f = extractFeatures({
    user_prompt: "/qa run integration tests",
    is_skill: true,
    skill_name: "qa",
    source: "claude-code",
    model: "claude-sonnet-4-6",
    timestamp: "2026-01-15T10:30:00Z",
    token_usage: { input: 0, output: 0, cache_read: 0, total: 0 },
  });
  assert.equal(f.is_skill, 1);
  assert.equal(f.skill_name, "qa");
  assert.equal(f.source, "claude-code");
  assert.equal(f.hour_of_day, 10);
});

test("extractFeatures detects code fences and file paths", () => {
  const f = extractFeatures({
    user_prompt: "fix bug in src/lib/foo.ts and tests/bar.test.mjs:\n```ts\ncode\n```",
    source: "claude-code",
    model: "x",
    timestamp: "2026-01-15T10:30:00Z",
    token_usage: { input: 0, output: 0, cache_read: 0, total: 0 },
  });
  assert.equal(f.prompt_has_code, 1);
  assert.ok(f.prompt_file_path_count >= 2);
});

test("extractQueryFeatures fills sensible defaults", () => {
  const q = extractQueryFeatures("/ship publish v1.2.0", { source: "claude-code" });
  assert.equal(q.is_skill, 1);
  assert.equal(q.skill_name, "ship");
  assert.equal(q.source, "claude-code");
  assert.equal(q.turn_index, 0);
  assert.equal(q.is_first_turn, 1);
});
