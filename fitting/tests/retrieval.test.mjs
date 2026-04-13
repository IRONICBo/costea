import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/retrieval/tokenizer.mjs";
import { TfidfVectorizer } from "../src/retrieval/embed.mjs";
import { KnnIndex, sparseCosine } from "../src/retrieval/knn.mjs";

test("tokenize emits Latin words and CJK bigrams in one pass", () => {
  const toks = tokenize("Refactor 重构 the auth 中间件");
  assert.ok(toks.includes("refactor"));
  assert.ok(toks.includes("auth"));
  assert.ok(toks.includes("重构"));
  assert.ok(toks.includes("中间") || toks.includes("间件"));
});

test("tokenize drops English stopwords by default", () => {
  const toks = tokenize("the quick brown fox is on the mat");
  // 'the', 'is', 'on' should be gone
  assert.ok(!toks.includes("the"));
  assert.ok(!toks.includes("is"));
  assert.ok(!toks.includes("on"));
  assert.ok(toks.includes("quick"));
});

test("TfidfVectorizer produces sparse L2-normed vectors", () => {
  const v = new TfidfVectorizer({ minDf: 1 }).fit([
    "auth jwt middleware",
    "auth oauth refactor",
    "frontend react component",
  ]);
  const vec = v.transform("auth jwt");
  assert.ok(vec.indices.length > 0);
  // L2 norm should be ~1
  const sumSq = vec.values.reduce((s, x) => s + x * x, 0);
  assert.ok(Math.abs(sumSq - 1) < 1e-9);
});

test("sparseCosine commutes and self-matches to 1", () => {
  // Need ≥3 docs so the default maxDfRatio=0.6 doesn't filter everything.
  const v = new TfidfVectorizer({ minDf: 1 }).fit([
    "auth jwt middleware foo bar",
    "react frontend component button input",
    "database migration index column",
    "logging metrics dashboard panel chart",
  ]);
  const a = v.transform("auth jwt middleware");
  const b = v.transform("middleware jwt auth");
  assert.ok(Math.abs(sparseCosine(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(sparseCosine(a, b) - sparseCosine(b, a)) < 1e-9);
  assert.ok(Math.abs(sparseCosine(a, b) - 1) < 1e-9);
});

test("KnnIndex returns top-k by cosine + skill boost", () => {
  const corpus = [
    "auth jwt middleware refactor",
    "frontend react component",
    "auth oauth two factor",
    "database migration script",
  ];
  const v = new TfidfVectorizer({ minDf: 1 }).fit(corpus);
  const vecs = corpus.map((c) => v.transform(c));
  const metas = [
    { skill_name: null, source: "claude-code", timestamp: "2026-01-01T00:00:00Z" },
    { skill_name: null, source: "claude-code", timestamp: "2026-01-02T00:00:00Z" },
    { skill_name: "qa",  source: "claude-code", timestamp: "2026-01-03T00:00:00Z" },
    { skill_name: null, source: "openclaw",    timestamp: "2026-01-04T00:00:00Z" },
  ];
  const idx = new KnnIndex(vecs, metas);
  const q = v.transform("auth jwt");
  const r = idx.search(q, { skill_name: "qa", source: "claude-code" }, { k: 3 });
  assert.equal(r.length, 3);
  // skill match on doc 2 should boost it above doc 0's pure-cosine win
  const ranks = r.map((x) => x.idx);
  assert.ok(ranks.includes(0));
  assert.ok(ranks.includes(2));
});

test("KnnIndex causal asOf filter excludes future records", () => {
  const v = new TfidfVectorizer({ minDf: 1 }).fit(["a b c"]);
  const idx = new KnnIndex(
    [v.transform("a b c")],
    [{ timestamp: "2026-06-01T00:00:00Z" }],
  );
  const r = idx.search(v.transform("a b c"), {}, { asOf: new Date("2026-01-01T00:00:00Z") });
  assert.equal(r.length, 0);
});
