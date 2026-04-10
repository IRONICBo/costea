#!/usr/bin/env bash
set -euo pipefail

# Costea: Log a cost estimate (and optionally actual results) to estimates.jsonl
#
# Usage:
#   log-estimate.sh --predict '<json>'              # Log prediction before execution
#   log-estimate.sh --actual '<estimate_id>' '<json>'  # Append actual results after execution
#
# Prediction JSON schema:
#   { "task": "...", "input_tokens": N, "output_tokens": N, "tool_calls": N,
#     "total_cost": N, "confidence": N, "estimate_method": "...",
#     "similar_tasks": N, "provider": "..." }
#
# Actual JSON schema:
#   { "input_tokens": N, "output_tokens": N, "cache_read": N, "tool_calls": N,
#     "total_cost": N }
#
# Output: ~/.costea/estimates.jsonl (append-only)

COSTEA_DIR="$HOME/.costea"
ESTIMATES_FILE="$COSTEA_DIR/estimates.jsonl"

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq is required"}' >&2
  exit 1
fi

mkdir -p "$COSTEA_DIR"

MODE=""
ESTIMATE_ID=""
DATA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --predict)  MODE="predict"; DATA="$2"; shift 2 ;;
    --actual)   MODE="actual"; ESTIMATE_ID="$2"; DATA="$3"; shift 3 ;;
    *)          echo "Usage: $0 --predict '<json>' | --actual '<id>' '<json>'" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODE" || -z "$DATA" ]]; then
  echo "Usage: $0 --predict '<json>' | --actual '<id>' '<json>'" >&2
  exit 1
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [[ "$MODE" == "predict" ]]; then
  # Generate unique estimate ID
  ESTIMATE_ID="est_$(date +%s)_$$"

  # Write prediction record
  echo "$DATA" | jq -c --arg id "$ESTIMATE_ID" --arg ts "$NOW" '{
    record_type: "estimate",
    estimate_id: $id,
    timestamp: $ts,
    status: "pending",
    predicted: {
      task: .task,
      input_tokens: (.input_tokens // 0),
      output_tokens: (.output_tokens // 0),
      cache_read_tokens: (.cache_read_tokens // 0),
      tool_calls: (.tool_calls // 0),
      total_cost: (.total_cost // 0),
      confidence: (.confidence // 0),
      estimate_method: (.estimate_method // "unknown"),
      similar_tasks: (.similar_tasks // 0),
      provider: (.provider // "unknown")
    },
    actual: null,
    accuracy: null
  }' >> "$ESTIMATES_FILE"

  echo "$ESTIMATE_ID"

elif [[ "$MODE" == "actual" ]]; then
  # Read the actual data and compute accuracy
  ACTUAL_JSON=$(echo "$DATA" | jq -c '{
    input_tokens: (.input_tokens // 0),
    output_tokens: (.output_tokens // 0),
    cache_read_tokens: (.cache_read_tokens // 0),
    tool_calls: (.tool_calls // 0),
    total_cost: (.total_cost // 0)
  }')

  # Find the prediction record and update it
  # Since JSONL is append-only, we append a new "completed" record
  # that references the original estimate_id
  PREDICTED=$(grep "\"$ESTIMATE_ID\"" "$ESTIMATES_FILE" 2>/dev/null | head -1)

  if [[ -z "$PREDICTED" ]]; then
    echo "Estimate $ESTIMATE_ID not found" >&2
    exit 1
  fi

  # Compute accuracy metrics
  echo "$PREDICTED" | jq -c \
    --arg ts "$NOW" \
    --argjson actual "$ACTUAL_JSON" '
    .status = "completed" |
    .completed_at = $ts |
    .actual = $actual |
    .accuracy = {
      input_ratio: (if .predicted.input_tokens > 0 then ($actual.input_tokens / .predicted.input_tokens * 100 | round) else null end),
      output_ratio: (if .predicted.output_tokens > 0 then ($actual.output_tokens / .predicted.output_tokens * 100 | round) else null end),
      cost_ratio: (if .predicted.total_cost > 0 then ($actual.total_cost / .predicted.total_cost * 100 | round) else null end),
      tool_ratio: (if .predicted.tool_calls > 0 then ($actual.tool_calls / .predicted.tool_calls * 100 | round) else null end),
      cost_error_pct: (if .predicted.total_cost > 0 then ((($actual.total_cost - .predicted.total_cost) / .predicted.total_cost * 100) | . * 10 | round / 10) else null end)
    }
  ' >> "$ESTIMATES_FILE"

  echo "Updated $ESTIMATE_ID with actual results" >&2
fi
