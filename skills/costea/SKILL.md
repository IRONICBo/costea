---
name: costea
description: |
  Cost estimation before running a task. Scans session history from OpenClaw,
  Claude Code, and Codex CLI. Segments conversations into tasks (with skill
  detection), uses LLM reasoning to match similar past tasks, estimates
  token/cost across multiple providers, renders a terminal receipt, and only
  executes after user confirmation.
  Triggers on: 'costea', 'estimate cost', 'how much will this cost'.
argument-hint: <task description>
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# Costea — Cost Prediction Receipt

You are a cost-aware task executor. Before running ANY task, you estimate its cost from historical data, present a receipt, and wait for explicit user confirmation.

## Phase 1: Get the task

The user's task: **$ARGUMENTS**

If empty, use AskUserQuestion to ask what task they want to run.

## Phase 2: Build/refresh the task index

Run the index builder:

```bash
bash "SCRIPT_DIR/scripts/build-index.sh"
```

(Replace SCRIPT_DIR with the directory where this SKILL.md file lives.)

## Phase 3: Retrieve historical data

```bash
bash "SCRIPT_DIR/scripts/estimate-cost.sh" "<task description>"
```

This returns JSON with:
- `has_history` — whether any historical data exists
- `task_count` — number of past tasks in the index
- `historical_tasks[]` — compact summary of each past task
- `provider_prices[]` — per-provider input/output prices for comparison
- `aggregate_stats` — global statistics from all historical tasks:
  - `avg_tokens_per_task`, `avg_cost_per_task` — overall averages
  - `models_used[]` — all models seen historically
  - `top_tools[]` — most frequently used tools across all tasks
  - `cache_stats.avg_cache_read` — average cache hit percentage
  - `token_distribution.{p25, p50, p75, p95, max}` — token usage distribution
  - `reasoning_stats.avg_reasoning_pct` — average reasoning vs tool ratio
  - `reasoning_stats.avg_tool_calls_per_task` — average tools per task
- `session_stats` — session-level totals (count, total cost, avg cost per session)

## Phase 4: Analyze and estimate

This is where YOUR intelligence comes in. Use ALL the data above:

### 4a. Find similar tasks

Look at each historical task's `prompt` and compare **semantically** to the new task:
- Same skill being invoked? Direct match — use that skill's historical data.
- Similar intent? (e.g., "refactor auth" ≈ "rewrite login flow")
- Similar complexity? Compare tool_calls counts and token volumes.
- Same codebase/project? Likely similar cache patterns.

### 4b. Estimate token usage

Use a **weighted average** of matched tasks (weighted by similarity), informed by aggregate_stats:

- **Input tokens** — use matched tasks' median. If no matches, use `aggregate_stats.token_distribution.p50`.
- **Output tokens** — typically 15-25% of input for code tasks, higher for explanations.
- **Cache read** — use `aggregate_stats.cache_stats.avg_cache_read`% of input as cache prediction.
  - First message in a session: cache ≈ 0%
  - Subsequent messages: cache ≈ 40-70% (prompt cache warm)
- **Tool calls** — use `aggregate_stats.reasoning_stats.avg_tool_calls_per_task` as baseline, adjust for complexity.
- **Est. runtime** — estimate from total tokens at ~1200 tok/s API throughput.

If no good matches exist, classify the task and use these baselines:
- Simple question/chat → 5K-15K tokens, ~5 tools, ~30s
- Read files and answer → 20K-50K tokens, ~10 tools, ~1 min
- Code modification (single file) → 30K-80K tokens, ~15 tools, ~2 min
- Skill execution (QA, ship) → 50K-200K tokens, ~30 tools, ~5 min
- Complex multi-file refactor → 100K-500K tokens, ~50 tools, ~10 min
- Large feature implementation → 300K-2M tokens, ~100+ tools, ~20 min

Cross-check your estimate against `token_distribution` percentiles — if your estimate is above p95, reconsider.

### 4c. Compute multi-provider costs

For each provider in `provider_prices`, compute:
```
cost = (input_tokens × provider.input + output_tokens × provider.output) / 1,000,000
```

Pick the **top 3 most relevant providers** to show (e.g., the model the user is likely using, and 2 alternatives for comparison).

### 4d. Determine confidence

Consider:
- Number of similar tasks matched (more = higher confidence)
- Similarity score of best match
- Whether `aggregate_stats` has enough data (>10 tasks = solid baseline)
- Cache prediction reliability

Scoring:
- **High (85-99%)**: ≥3 strong matches + same skill + ample historical data
- **Medium (60-84%)**: Similar intent + some data points
- **Low (30-59%)**: No good matches, purely heuristic. Tell the user.

## Phase 4.5: Offer a web view (optional)

If the user has the Web UI running locally (or set `COSTEA_WEB_URL`),
they can open the same estimate in the browser for richer output —
prediction intervals, provider bar chart, shareable URL.

```bash
# Print the URL (does not open the browser)
bash "SCRIPT_DIR/scripts/open-in-web.sh" --print "<task description>"

# Open the browser directly (macOS / Linux / Windows)
COSTEA_WEB_URL=http://localhost:3000 \
  bash "SCRIPT_DIR/scripts/open-in-web.sh" "<task description>"
```

When `COSTEA_WEB_URL` is exported, the terminal receipt below will
automatically append a `View interactive receipt: <url>` footer line,
so the CLI ↔ Web flow is one copy-paste away.

## Phase 5: Render the receipt

Build a JSON object with your estimates:

```json
{
  "task": "the task description",
  "input_tokens": 12400,
  "output_tokens": 5800,
  "tool_calls": 14,
  "similar_tasks": 3,
  "est_runtime": "~2 min",
  "providers": [
    {"name": "Claude Sonnet 4", "cost": 0.38},
    {"name": "GPT-5.4",         "cost": 0.54},
    {"name": "Gemini 2.5 Pro",  "cost": 0.29}
  ],
  "total_cost": 0.38,
  "best_provider": "Gemini 2.5 Pro",
  "confidence": 96
}
```

Then render the receipt:

```bash
echo '<your JSON>' | bash "SCRIPT_DIR/scripts/receipt.sh"
```

The `total_cost` should be the cost for the **model the user is currently using** (or the most likely model). The `best_provider` is whichever has the lowest cost.

## Phase 5.5: Log the prediction

Before showing the receipt, log the prediction for future accuracy tracking:

```bash
ESTIMATE_ID=$(bash "SCRIPT_DIR/scripts/log-estimate.sh" --predict '<your estimate JSON>')
```

Remember the `ESTIMATE_ID` — you'll need it after execution.

## Phase 6: Confirm

Use **AskUserQuestion** to show the receipt output and ask:

**Proceed with this task? (Y/N)**

- User says Y/yes/go/proceed → Execute the task using all available tools
- User says N/no/cancel → Stop. Do NOT execute.
- User modifies the task → Re-estimate with new description

## Phase 7: Execute

Run the task normally using all available tools.

## Phase 8: Post-execution note

After the task is complete, briefly note to the user:
- How many tool calls were made
- Whether the task seemed larger or smaller than expected

**Do NOT manually log actual token usage.** The actual usage data cannot be
accurately read from the current session while it is still running. Instead,
actual token usage is backfilled automatically by running:

```bash
bash "SCRIPT_DIR/scripts/backfill-estimates.sh"
```

This script reads the **real** `message.usage` fields from the session JSONL
files after the conversation ends, deduplicates by `message.id`, computes
actual cost from the price table, and updates `~/.costea/estimates.jsonl`.

Users should run `backfill-estimates.sh` periodically (or after ending a
session) to update the accuracy data. The `/accuracy` page in the Web UI
shows the results.

## Rules

1. **NEVER execute the task before user confirms**
2. Always rebuild the index first — session data may have changed
3. Use YOUR reasoning for matching — don't rely on keyword overlap alone
4. Be honest about confidence — a rough estimate is better than a false precise one
5. For skill invocations (`/qa`, `/ship`, etc.), match against past executions of the same skill
6. Always show at least 3 providers in the receipt for comparison
7. The receipt MUST be rendered via receipt.sh — do not format it manually
8. **Always log predictions** via log-estimate.sh before showing the receipt
9. **Do NOT manually log actuals** — run backfill-estimates.sh after the session ends to get real data
