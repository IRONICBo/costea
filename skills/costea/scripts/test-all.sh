#!/usr/bin/env bash
set -euo pipefail

# Costea: Run all test cases against real session data
# Usage: bash scripts/test-all.sh
# Exit code 0 = all pass, non-zero = failures

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COSTEA_DIR="$HOME/.costea"
PASS=0 FAIL=0 SKIP=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

echo "=== Costea Test Suite ==="
echo ""

# ── T1: build-index.sh ──────────────────────────────────────────────────────
echo "T1: build-index.sh"
if bash "$SCRIPT_DIR/build-index.sh" >/dev/null 2>&1; then
  count=$(jq '.task_count // 0' "$COSTEA_DIR/task-index.json" 2>/dev/null)
  if [[ "$count" -gt 0 ]]; then
    pass "built index with $count tasks"
  else
    fail "index built but 0 tasks"
  fi
else
  fail "build-index.sh exited with error"
fi

# ── T2: estimate-cost.sh (with task) ────────────────────────────────────────
echo "T2: estimate-cost.sh (with task)"
output=$(bash "$SCRIPT_DIR/estimate-cost.sh" "refactor the auth module" 2>/dev/null)
if echo "$output" | jq -e '.has_history' >/dev/null 2>&1; then
  hist_len=$(echo "$output" | jq '.historical_tasks | length' 2>/dev/null)
  has_agg=$(echo "$output" | jq '.aggregate_stats != null' 2>/dev/null)
  if [[ "$has_agg" == "true" ]]; then
    pass "returned $hist_len historical tasks + aggregate_stats"
  else
    fail "missing aggregate_stats"
  fi
else
  fail "invalid JSON output"
fi

# ── T3: estimate-cost.sh (empty) ────────────────────────────────────────────
echo "T3: estimate-cost.sh (empty task)"
output=$(bash "$SCRIPT_DIR/estimate-cost.sh" "" 2>/dev/null || true)
if echo "$output" | jq -e '.error' >/dev/null 2>&1; then
  pass "returned error for empty task"
else
  fail "no error for empty task"
fi

# ── T4: receipt.sh ───────────────────────────────────────────────────────────
echo "T4: receipt.sh"
receipt_out=$(echo '{"task":"test","input_tokens":10000,"output_tokens":3000,"tool_calls":8,"similar_tasks":2,"est_runtime":"~1 min","providers":[{"name":"Sonnet","cost":0.08}],"total_cost":0.08,"best_provider":"Sonnet","confidence":75}' | bash "$SCRIPT_DIR/receipt.sh" 2>&1)
if echo "$receipt_out" | grep -q "C O S T E A"; then
  pass "receipt rendered"
else
  fail "receipt missing header"
fi

# ── T5: parse-claudecode.sh ──────────────────────────────────────────────────
echo "T5: parse-claudecode.sh"
CLAUDE_FILE=$(find ~/.claude/projects/ -maxdepth 2 -name "*.jsonl" -not -path "*/subagents/*" 2>/dev/null | head -1)
if [[ -n "$CLAUDE_FILE" ]]; then
  if bash "$SCRIPT_DIR/parse-claudecode.sh" --force "$CLAUDE_FILE" >/dev/null 2>&1; then
    SID=$(basename "$CLAUDE_FILE" .jsonl)
    lines=$(wc -l < "$COSTEA_DIR/sessions/$SID/llm-calls.jsonl" 2>/dev/null || echo 0)
    if [[ "$lines" -gt 0 ]]; then
      pass "parsed $lines LLM calls"
    else
      fail "0 LLM calls from claude session"
    fi
  else
    fail "parse-claudecode.sh exited with error"
  fi
else
  skip "no Claude Code sessions found"
fi

# ── T6: parse-codex.sh ──────────────────────────────────────────────────────
echo "T6: parse-codex.sh"
CODEX_FILE=$(find ~/.codex/sessions/ -name "rollout-*.jsonl" 2>/dev/null | head -1)
if [[ -n "$CODEX_FILE" ]]; then
  if bash "$SCRIPT_DIR/parse-codex.sh" --force "$CODEX_FILE" >/dev/null 2>&1; then
    SID=$(jq -r 'select(.type == "session_meta") | .payload.id // empty' "$CODEX_FILE" 2>/dev/null | head -1)
    lines=$(wc -l < "$COSTEA_DIR/sessions/$SID/session.jsonl" 2>/dev/null || echo 0)
    if [[ "$lines" -gt 0 ]]; then
      pass "parsed $lines turns"
    else
      fail "0 turns from codex session"
    fi
  else
    fail "parse-codex.sh exited with error"
  fi
else
  skip "no Codex CLI sessions found"
fi

# ── T7: parse-openclaw.sh ───────────────────────────────────────────────────
echo "T7: parse-openclaw.sh"
OC_FILE=$(find ~/.openclaw/agents/main/sessions/ -name "*.jsonl" 2>/dev/null | sort -r | head -1)
if [[ -n "$OC_FILE" ]]; then
  OC_SID=$(basename "$OC_FILE" .jsonl)
  if bash "$SCRIPT_DIR/parse-openclaw.sh" --force "$OC_FILE" --sid "$OC_SID" >/dev/null 2>&1; then
    pass "parse-openclaw.sh completed (session: $OC_SID)"
  else
    fail "parse-openclaw.sh exited with error"
  fi
else
  skip "no OpenClaw sessions found"
fi

# ── T8: summarize-session.sh ────────────────────────────────────────────────
echo "T8: summarize-session.sh"
SAMPLE_SID=$(ls "$COSTEA_DIR/sessions/" 2>/dev/null | head -1)
if [[ -n "$SAMPLE_SID" ]]; then
  if bash "$SCRIPT_DIR/summarize-session.sh" "$SAMPLE_SID" >/dev/null 2>&1; then
    if [[ -f "$COSTEA_DIR/sessions/$SAMPLE_SID/summary.json" ]]; then
      source_val=$(jq -r '.source // "missing"' "$COSTEA_DIR/sessions/$SAMPLE_SID/summary.json")
      pass "summary generated (source: $source_val)"
    else
      fail "summary.json not created"
    fi
  else
    fail "summarize-session.sh exited with error"
  fi
else
  skip "no parsed sessions"
fi

# ── T9: update-index.sh ─────────────────────────────────────────────────────
echo "T9: update-index.sh"
output=$(bash "$SCRIPT_DIR/update-index.sh" 2>&1)
if echo "$output" | grep -q "Index written"; then
  tracked=$(jq '.session_count // 0' "$COSTEA_DIR/index.json" 2>/dev/null)
  pass "index.json with $tracked sessions"
else
  fail "update-index.sh did not write index"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS pass, $FAIL fail, $SKIP skip ==="
[[ $FAIL -eq 0 ]]
