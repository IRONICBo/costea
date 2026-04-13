import { test } from "node:test";
import assert from "node:assert/strict";
import { filterUsable, annotateSequence, timeSplit } from "../src/data/loader.mjs";

const mkTask = (sid, ts, total = 100) => ({
  source: "claude-code",
  session_id: sid,
  model: "x",
  timestamp: ts,
  is_skill: false,
  skill_name: null,
  user_prompt: "do something",
  token_usage: { input: total / 2, output: total / 2, cache_read: 0, cache_write: 0, total },
  cost: { total: 0 },
  tools: [],
  total_tool_calls: 0,
});

test("filterUsable drops zero-token tasks and empty prompts", () => {
  const tasks = [
    mkTask("a", "2026-01-01"),
    { ...mkTask("b", "2026-01-02"), token_usage: { input:0, output:0, cache_read:0, total:0 } },
    { ...mkTask("c", "2026-01-03"), user_prompt: "" },
    { ...mkTask("d", "2026-01-04"), user_prompt: "  " },
  ];
  const u = filterUsable(tasks);
  assert.equal(u.length, 1);
  assert.equal(u[0].session_id, "a");
});

test("annotateSequence assigns turn_index and prior cumulative within session", () => {
  const tasks = [
    mkTask("s1", "2026-01-01T01:00:00Z", 100),
    mkTask("s1", "2026-01-01T02:00:00Z", 200),
    mkTask("s1", "2026-01-01T03:00:00Z", 300),
    mkTask("s2", "2026-01-01T01:30:00Z", 50),
  ];
  const ann = annotateSequence(tasks);
  // Find s1 turns in order
  const s1 = ann.filter((t) => t.session_id === "s1");
  assert.equal(s1[0].turn_index, 0);
  assert.equal(s1[0].prior_session_total, 0);
  assert.equal(s1[1].turn_index, 1);
  assert.equal(s1[1].prior_session_total, 100);
  assert.equal(s1[2].turn_index, 2);
  assert.equal(s1[2].prior_session_total, 300);
  // s2 starts fresh
  const s2 = ann.find((t) => t.session_id === "s2");
  assert.equal(s2.turn_index, 0);
  assert.equal(s2.prior_session_total, 0);
});

test("timeSplit defaults are 80/10/10 and respect order", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => mkTask("s", `2026-01-${String(i+1).padStart(2,"0")}T00:00:00Z`));
  const split = timeSplit(tasks);
  assert.equal(split.train.length, 8);
  assert.equal(split.val.length, 1);
  assert.equal(split.test.length, 1);
  // The latest timestamps go into test.
  assert.equal(split.test[0].timestamp, "2026-01-10T00:00:00Z");
});
