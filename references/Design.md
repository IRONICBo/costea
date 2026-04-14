# Costea Agent Token Tracking — 完整设计

> 版本：v1.0  日期：2026-04-07

---

## 一、目标

基于现有 JSONL 文件解析能力，构建一套能完整追踪每次对话、每次 LLM API 调用的 Token 消耗与费用的本地存储方案。要求：

1. **完整性** — 追踪到单次 LLM 调用粒度，含 subagent 归因
2. **可汇总** — 支持按 session / agent / model / skill / tool 多维聚合
3. **原始保留** — 永不修改原始数据，所有记录 append-only
4. **无外部依赖** — 纯 jq + shell，本地文件系统
5. **OTel 兼容** — 字段命名遵循 OpenTelemetry GenAI 语义约定，方便未来对接

---

## 二、核心问题与解决方案

### 2.1 并行工具调用去重

**问题：** Claude Code 在并行工具调用时，将同一次 API 响应拆分为多条 AssistantMessage，它们共享同一个 `message.id` 和完全相同的 `usage` 字段。直接求和会重复计数。

**解决：** 解析时对同一 `message.id` 只取第一条的 `usage`，后续相同 ID 的记录跳过计费统计。

```
message.id = "msg_abc" → usage: {input: 1000, output: 500}  ← 计费
message.id = "msg_abc" → usage: {input: 1000, output: 500}  ← 跳过（同 ID）
message.id = "msg_abc" → usage: {input: 1000, output: 500}  ← 跳过（同 ID）
```

### 2.2 Subagent Token 归因

**问题：** Claude Code 所有子 Agent 共享父 Session 的 `session_id`（Issue #7881 尚未修复），`SubagentStop` Hook 无法标识具体是哪个子 Agent 结束。

**解决：** 解析子 Agent 目录 `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`，通过文件路径中的 `agentId` 建立归因链：

```
parent_session_id → agent_id → sub-session JSONL
```

每个子 Agent 的 Token 同时写入：
- 子 Agent 自己的 `llm-calls.jsonl`（含 `parent_session_id`）
- 父 Session 的 `subagent_tokens` 累计字段

### 2.3 模型级别计费

**问题：** 一次对话可能使用多个模型（Opus 主循环 + Haiku 子任务），不同模型价格差异巨大。

**解决：** 每条 LLM Call 记录携带 `model` 字段，计费时按模型查表（见价格表），`summary.json` 中维护 `model_usage` 映射。

### 2.4 Codex CLI 累积 Token 计算

**问题：** Codex CLI 的 `token_count` 事件记录的是累积运行总计，不是增量。

**解决：** 解析时维护上一条累积值，per-turn 增量 = `current_total - previous_total`。

---

## 三、存储布局

```
~/.costea/
├── sessions/
│   └── {session_id}/              # 每个 session 一个目录
│       ├── session.jsonl          # 对话轮次记录（每条用户消息一行）
│       ├── llm-calls.jsonl        # LLM API 调用记录（去重后，每次 API 调用一行）
│       ├── tools.jsonl            # 工具调用记录（每次工具调用一行）
│       ├── agents.jsonl           # 子 Agent 生命周期事件（子 Agent 专用）
│       └── summary.json           # 聚合摘要（按需计算，可重新生成）
├── task-index.json                # 现有任务索引（build-index.sh 生成）
└── index.json                     # 全局 session 索引（轻量，仅元数据）
```

**设计原则：**
- `*.jsonl` 文件 append-only，永不修改
- `summary.json` 可随时从 JSONL 重新计算
- `index.json` 只存元数据指针，不存原始数据
- 目录名 = Claude Code 的 `sessionId`（UUID），与原始 JSONL 保持一致

---

## 四、表结构（JSONL Record Schema）

### 4.1 session.jsonl — 对话轮次记录

每条用户消息触发一行，记录该"轮次"的汇总信息。

```jsonc
{
  // ── 标识 ──────────────────────────────────────────────
  "record_type": "session_turn",
  "turn_id": "turn_20260407_120000_001",       // 本轮次唯一 ID：{session_id}/{timestamp}/{seq}
  "session_id": "a1b2c3d4-...",                // Claude Code sessionId（UUID）
  "parent_session_id": null,                   // 父 Session ID（子 Agent 时非空）
  "agent_id": null,                            // agentId（子 Agent 时非空）
  "source": "claude-code",                     // 平台：claude-code | codex | openclaw
  "timestamp": "2026-04-07T12:00:00.000Z",     // 用户消息时间戳

  // ── 任务描述 ──────────────────────────────────────────
  "user_prompt": "重构认证模块的登录流程",       // 用户消息（截断到 500 字符）
  "user_prompt_full_length": 23,               // 原始长度（字符数）
  "is_skill": true,                            // 是否通过技能调用
  "skill_name": "qa",                          // 技能名（非技能时为 null）
  "cwd": "/Users/xxx/Projects/myapp",          // 工作目录
  "git_branch": "feature/auth",                // Git 分支（可选）

  // ── Token 汇总（本轮所有 LLM 调用之和，已去重）──────────
  "token_usage": {
    "input": 25000,
    "output": 8500,
    "cache_read": 12000,                       // 缓存命中（低价）
    "cache_write": 1500,                       // 缓存写入（略高价）
    "total": 47000,
    "subagent_input": 0,                       // 子 Agent 贡献的 input tokens
    "subagent_output": 0,                      // 子 Agent 贡献的 output tokens
    "subagent_total": 0
  },

  // ── 费用（USD）─────────────────────────────────────────
  "cost": {
    "total_usd": 0.8250,
    "by_model": {
      "claude-opus-4-6": 0.7800,
      "claude-haiku-4-5": 0.0450
    }
  },

  // ── 工具调用汇总 ───────────────────────────────────────
  "tools_summary": {
    "total_calls": 12,
    "by_tool": {
      "Read": 5,
      "Write": 3,
      "Bash": 2,
      "Grep": 2
    }
  },

  // ── 推理 vs 工具调用分析 ───────────────────────────────
  "reasoning": {
    "message_count": 3,                        // stop_reason="stop" 的 assistant 消息数
    "tokens": 18000                            // 推理轮次消耗的 output tokens 估算
  },
  "tool_invocation": {
    "message_count": 9,                        // stop_reason="toolUse" 的消息数
    "tokens": 29000
  },

  // ── 时长 ───────────────────────────────────────────────
  "duration": {
    "wall_ms": 45230,                          // 挂钟时间
    "api_ms": 38100,                           // 纯 API 时间
    "tool_ms": 5200                            // 工具执行时间
  },

  // ── 子 Agent 汇总 ──────────────────────────────────────
  "subagents": {
    "count": 2,
    "agent_ids": ["agent-abc123", "agent-def456"]
  },

  // ── 关联 ───────────────────────────────────────────────
  "llm_call_count": 12,                        // 本轮 LLM 调用次数（去重后）
  "version": "1.0"
}
```

---

### 4.2 llm-calls.jsonl — LLM API 调用记录

每次 API 调用一行（已按 `message.id` 去重）。这是最细粒度的原始数据。

```jsonc
{
  // ── 标识 ──────────────────────────────────────────────
  "record_type": "llm_call",
  "call_id": "msg_01AbCdEf...",               // Anthropic message.id（去重键）
  "session_id": "a1b2c3d4-...",
  "parent_session_id": null,
  "agent_id": null,                           // 所属子 Agent（主线程时为 null）
  "turn_id": "turn_20260407_120000_001",      // 所属轮次
  "source": "claude-code",
  "timestamp": "2026-04-07T12:00:00.123Z",

  // ── 模型 ───────────────────────────────────────────────
  "model": "claude-opus-4-6-20260101",        // 完整模型名
  "model_short": "claude-opus-4-6",           // 规范化短名
  "is_fast_mode": false,                      // Opus 4.6 Fast Mode

  // ── Token（来自 API response usage 字段）──────────────
  "usage": {
    "input_tokens": 22000,
    "output_tokens": 3500,
    "cache_read_input_tokens": 8000,
    "cache_creation_input_tokens": 1000,
    "web_search_requests": 0
  },

  // ── 费用（USD）─────────────────────────────────────────
  "cost_usd": 0.5475,

  // ── 上下文窗口 ─────────────────────────────────────────
  "context_window": {
    "used": 34500,                            // input + cache_read + cache_write + output
    "model_max": 200000
  },

  // ── 调用属性 ───────────────────────────────────────────
  "stop_reason": "toolUse",                   // stop | toolUse | end_turn | max_tokens
  "is_reasoning_turn": false,                 // stop_reason=="stop" 时为 true
  "has_thinking": false,                      // 是否包含 extended thinking 内容

  // ── 关联工具调用 ───────────────────────────────────────
  "tool_calls": [
    {"tool_name": "Read", "tool_use_id": "toolu_01Xxx"},
    {"tool_name": "Write", "tool_use_id": "toolu_02Yyy"}
  ],

  // ── 去重标记 ───────────────────────────────────────────
  "dedup_siblings": 2,                        // 并行工具调用拆分出的兄弟记录数（>1 说明发生了去重）

  // ── 时长 ───────────────────────────────────────────────
  "api_duration_ms": 3200,

  "version": "1.0"
}
```

---

### 4.3 tools.jsonl — 工具调用记录

每次工具调用一行。

```jsonc
{
  // ── 标识 ──────────────────────────────────────────────
  "record_type": "tool_call",
  "tool_use_id": "toolu_01AbCdEf...",         // Anthropic tool_use_id
  "call_id": "msg_01AbCdEf...",               // 所属 LLM Call（message.id）
  "session_id": "a1b2c3d4-...",
  "agent_id": null,
  "turn_id": "turn_20260407_120000_001",
  "timestamp": "2026-04-07T12:00:01.000Z",

  // ── 工具属性 ───────────────────────────────────────────
  "tool_name": "Read",                        // 工具名
  "tool_category": "filesystem",              // filesystem | shell | search | agent | other
  "tool_input_summary": "file_path: /src/auth/login.ts",  // 输入摘要（敏感内容截断）

  // ── 结果 ───────────────────────────────────────────────
  "outcome": "success",                       // success | error | denied
  "duration_ms": 45,

  "version": "1.0"
}
```

---

### 4.4 agents.jsonl — 子 Agent 生命周期记录

子 Agent（subagent）专用，记录启动和结束事件。

```jsonc
{
  // ── 标识 ──────────────────────────────────────────────
  "record_type": "agent_event",
  "event_type": "start",                      // start | stop
  "agent_id": "agent-abc123def",              // 从文件路径提取
  "session_id": "a1b2c3d4-...",               // 父 Session ID
  "turn_id": "turn_20260407_120000_001",      // 触发子 Agent 的轮次
  "timestamp": "2026-04-07T12:00:02.000Z",

  // ── 子 Agent 属性 ──────────────────────────────────────
  "agent_file": "subagents/agent-abc123def.jsonl",  // 相对路径
  "agent_name": null,                         // 自定义名（来自 /rename 或 swarm）
  "agent_type": null,                         // subagent_type（来自工具调用参数）
  "task_description": "实现用户登录功能",      // Task 工具调用的描述（截断）

  // ── 停止事件附加字段（event_type="stop" 时有值）────────
  "final_token_usage": {
    "input": 8000,
    "output": 2500,
    "cache_read": 3000,
    "cache_write": 500,
    "total": 14000
  },
  "final_cost_usd": 0.2150,
  "llm_call_count": 4,
  "duration_ms": 15000,

  "version": "1.0"
}
```

---

### 4.5 summary.json — Session 聚合摘要

按需计算，从 `session.jsonl` + `llm-calls.jsonl` + `tools.jsonl` + `agents.jsonl` 汇总生成。

```jsonc
{
  "session_id": "a1b2c3d4-...",
  "source": "claude-code",
  "project_path": "/Users/xxx/Projects/myapp",
  "git_branch": "feature/auth",

  // ── 时间 ───────────────────────────────────────────────
  "started_at": "2026-04-07T11:45:00.000Z",
  "ended_at": "2026-04-07T12:30:00.000Z",
  "duration_ms": 2700000,

  // ── 对话统计 ───────────────────────────────────────────
  "turn_count": 8,                            // 用户消息数（对话轮次）
  "llm_call_count": 45,                       // LLM API 调用次数（去重后）
  "tool_call_count": 62,                      // 工具调用次数

  // ── Token 汇总 ─────────────────────────────────────────
  "token_usage": {
    "input": 180000,
    "output": 42000,
    "cache_read": 95000,
    "cache_write": 8500,
    "total": 325500,
    "subagent_total": 28000
  },

  // ── 费用 ───────────────────────────────────────────────
  "cost": {
    "total_usd": 5.2340,
    "by_model": {
      "claude-opus-4-6": {
        "input": 150000,
        "output": 38000,
        "cache_read": 90000,
        "cache_write": 8000,
        "cost_usd": 4.9800
      },
      "claude-haiku-4-5": {
        "input": 30000,
        "output": 4000,
        "cache_read": 5000,
        "cache_write": 500,
        "cost_usd": 0.2540
      }
    }
  },

  // ── 技能 ───────────────────────────────────────────────
  "skills": {
    "qa": {"turns": 3, "tokens": 180000, "cost_usd": 3.1200},
    "(conversation)": {"turns": 5, "tokens": 145500, "cost_usd": 2.1140}
  },

  // ── 工具 ───────────────────────────────────────────────
  "top_tools": [
    {"name": "Read", "calls": 28},
    {"name": "Bash", "calls": 15},
    {"name": "Write", "calls": 12},
    {"name": "Grep", "calls": 7}
  ],

  // ── 推理分析 ───────────────────────────────────────────
  "reasoning_vs_tools": {
    "reasoning_turns": 12,
    "tool_turns": 33,
    "reasoning_pct": 27
  },

  // ── 子 Agent ───────────────────────────────────────────
  "subagents": {
    "count": 3,
    "total_tokens": 28000,
    "total_cost_usd": 0.4200,
    "agents": [
      {
        "agent_id": "agent-abc123def",
        "tokens": 14000,
        "cost_usd": 0.2150,
        "llm_calls": 4,
        "duration_ms": 15000
      }
    ]
  },

  // ── 最贵轮次 ───────────────────────────────────────────
  "top_turns_by_cost": [
    {
      "turn_id": "turn_20260407_120000_003",
      "prompt": "实现完整的 OAuth2 登录流程...",
      "tokens": 95000,
      "cost_usd": 1.8500
    }
  ],

  "generated_at": "2026-04-07T12:31:00.000Z",
  "version": "1.0"
}
```

---

### 4.6 index.json — 全局 Session 索引

```jsonc
{
  "updated_at": "2026-04-07T12:31:00.000Z",
  "session_count": 42,
  "sessions": [
    {
      "session_id": "a1b2c3d4-...",
      "source": "claude-code",
      "started_at": "2026-04-07T11:45:00.000Z",
      "ended_at": "2026-04-07T12:30:00.000Z",
      "project_path": "/Users/xxx/Projects/myapp",
      "turn_count": 8,
      "total_tokens": 325500,
      "total_cost_usd": 5.2340,
      "summary_path": "sessions/a1b2c3d4-.../summary.json"
    }
  ]
}
```

---

## 五、数据流与解析流程

```
原始平台文件
    │
    ├── Claude Code
    │   ~/.claude/projects/{proj}/{sessionId}.jsonl
    │   ~/.claude/projects/{proj}/{sessionId}/subagents/agent-{id}.jsonl
    │
    ├── Codex CLI
    │   ~/.codex/sessions/YYYY/MM/DD/rollup-*.jsonl
    │
    └── OpenClaw
        ~/.openclaw/agents/main/sessions/*.jsonl
            │
            ▼
    ┌─────────────────────────────────────────────────────┐
    │              parse-session.sh（核心解析）             │
    │                                                     │
    │  1. 读取 JSONL，过滤 type="assistant" 的记录         │
    │  2. 按 message.id 去重（并行工具调用）               │
    │  3. 识别 stop_reason → 推理 vs 工具调用              │
    │  4. 识别技能调用模式                                 │
    │  5. 按 token 数和模型计算费用                        │
    │  6. 写入 ~/.costea/sessions/{id}/*.jsonl             │
    └─────────────────────────────────────────────────────┘
            │
            ▼
    ┌─────────────────────────────────────────────────────┐
    │              summarize-session.sh                   │
    │                                                     │
    │  从 *.jsonl 聚合生成 summary.json                   │
    │  更新 index.json                                    │
    └─────────────────────────────────────────────────────┘
            │
            ├── /costea → estimate-cost.sh（从 task-index 检索）
            └── /costeamigo → report.sh（从 index.json + summary 聚合）
```

---

## 六、解析规则

### 6.1 Claude Code JSONL 解析

**文件位置：**
```
~/.claude/projects/{urlencoded-project-path}/{sessionId}.jsonl
~/.claude/projects/{urlencoded-project-path}/{sessionId}/subagents/agent-{agentId}.jsonl
```

**关键字段映射：**

| 原始字段 | 存储字段 | 说明 |
|---------|---------|------|
| `message.usage.input_tokens` | `usage.input_tokens` | 标准输入 |
| `message.usage.output_tokens` | `usage.output_tokens` | 输出 |
| `message.usage.cache_read_input_tokens` | `usage.cache_read_input_tokens` | 缓存命中 |
| `message.usage.cache_creation_input_tokens` | `usage.cache_creation_input_tokens` | 缓存写入 |
| `message.usage.server_tool_use.web_search_requests` | `usage.web_search_requests` | 网页搜索 |
| `message.id` | `call_id` | 去重键 |
| `message.stop_reason` | `stop_reason` | 推理/工具判断 |
| `message.model` | `model` | 模型名 |
| `sessionId` | `session_id` | |
| `agentId` | `agent_id` | 子 Agent |
| `isSidechain` | — | 标识子 Agent 记录 |
| `timestamp` | `timestamp` | |

**去重逻辑（jq）：**
```bash
# 按 message.id 去重：同一 ID 只保留第一次出现
jq -s '[.[] | select(.type == "assistant") | select(.message.usage != null)]
  | group_by(.message.id)
  | map(.[0])'
```

**子 Agent 归因：**
```bash
# 扫描所有 subagent 文件
find ~/.claude/projects -path "*/subagents/agent-*.jsonl" | while read f; do
  agent_id=$(basename "$f" .jsonl | sed 's/^agent-//')
  session_id=$(basename "$(dirname "$(dirname "$f")")")
  # 解析 $f，写入 ~/.costea/sessions/$session_id/agents.jsonl
done
```

### 6.2 Codex CLI JSONL 解析

**累积增量计算（jq）：**
```bash
jq -s '
  [.[] | select(.payload.type == "token_count")]
  | to_entries
  | map({
      index: .key,
      current: .value.payload,
      prev: (if .key > 0 then .[((.key)-1)].value.payload else null end)
    })
  | map({
      delta_input: (.current.input_tokens - (if .prev then .prev.input_tokens else 0 end)),
      delta_output: (.current.output_tokens - (if .prev then .prev.output_tokens else 0 end)),
      timestamp: .current.timestamp
    })
'
```

### 6.3 OpenClaw JSONL 解析

```bash
# OpenClaw 直接提供 per-message usage 和 cost，无需计算
jq '.messages[] | select(.role == "assistant") | {
  input: .usage.inputTokens,
  output: .usage.outputTokens,
  cache_read: .usage.cacheRead,
  cache_write: .usage.cacheWrite,
  cost: .usage.cost
}'
```

---

## 七、计费规则

### 7.1 价格表（每百万 Token，USD）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 网页搜索/次 |
|------|------|------|--------|--------|-----------|
| claude-opus-4-6（普通） | $5 | $25 | $0.50 | $6.25 | $0.01 |
| claude-opus-4-6（Fast Mode） | $30 | $150 | $3.00 | $37.50 | $0.01 |
| claude-opus-4（= 4.1） | $15 | $75 | $1.50 | $18.75 | $0.01 |
| claude-sonnet-4-6 | $3 | $15 | $0.30 | $3.75 | $0.01 |
| claude-sonnet-4（= 4.5） | $3 | $15 | $0.30 | $3.75 | $0.01 |
| claude-haiku-4-5 | $1 | $5 | $0.10 | $1.25 | $0.01 |
| claude-haiku-3-5 | $0.80 | $4 | $0.08 | $1.00 | $0.01 |
| gpt-5.4 | $2.50 | $15 | — | — | — |
| gpt-5.2-codex | $1.07 | $8.50 | — | — | — |

> **数据来源：** `claude-code-main/src/utils/modelCost.ts` 中的 `COST_TIER_*` 常量。

### 7.2 计费公式（shell + jq）

```bash
# 给定 token 数和模型，计算 USD 费用
calculate_cost() {
  local model="$1"
  local input="$2" output="$3" cache_read="$4" cache_write="$5"

  # 价格表（每 1M tokens，USD）
  case "$model" in
    *opus-4-6*|*opus-4.6*)
      price_input=5; price_output=25; price_cache_read=0.50; price_cache_write=6.25 ;;
    *opus-4*|*opus-4.1*)
      price_input=15; price_output=75; price_cache_read=1.50; price_cache_write=18.75 ;;
    *sonnet*)
      price_input=3; price_output=15; price_cache_read=0.30; price_cache_write=3.75 ;;
    *haiku-4-5*|*haiku-4.5*)
      price_input=1; price_output=5; price_cache_read=0.10; price_cache_write=1.25 ;;
    *haiku*)
      price_input=0.80; price_output=4; price_cache_read=0.08; price_cache_write=1.00 ;;
    *gpt-5.4*)
      price_input=2.50; price_output=15; price_cache_read=0; price_cache_write=0 ;;
    *codex*)
      price_input=1.07; price_output=8.50; price_cache_read=0; price_cache_write=0 ;;
    *)
      price_input=5; price_output=25; price_cache_read=0.50; price_cache_write=6.25 ;;  # 默认 opus-4-6
  esac

  echo "scale=8; ($input * $price_input + $output * $price_output + $cache_read * $price_cache_read + $cache_write * $price_cache_write) / 1000000" | bc
}
```

---

## 八、脚本架构

```
scripts/
├── parse-session.sh          # 解析单个平台 Session → 写入 ~/.costea/sessions/{id}/
├── build-index.sh            # 现有：全量扫描 → task-index.json（复用，兼容新结构）
├── summarize-session.sh      # 从 *.jsonl 重新生成 summary.json
├── update-index.sh           # 增量更新 index.json（扫描新 session）
├── estimate-cost.sh          # 现有：检索历史估算（基于 task-index）
├── report.sh                 # 现有：多维报告（从 index.json + summary 聚合）
└── lib/
    ├── cost.sh               # 计费函数（价格表 + calculate_cost）
    ├── dedup.sh              # message.id 去重逻辑
    └── platform.sh           # 平台特定解析函数
```

---

## 九、与现有能力的兼容关系

| 现有组件 | 变化 |
|---------|------|
| `build-index.sh` | **保留**。继续生成 `task-index.json`，供 `/costea` 使用。内部解析逻辑迁移到 `lib/platform.sh` 共享 |
| `estimate-cost.sh` | **不变**。继续基于 `task-index.json` 工作 |
| `report.sh` | **扩展**。增加从 `~/.costea/sessions/` 读取更精细数据的选项（`--detail` 模式）|
| `analyze-tokens.sh` | **保留**。作为 OpenClaw 专用调试工具 |
| `task-index.json` | **保留**。维持现有 schema，仅在 `token_usage` 中新增 `subagent_total` 字段 |

---

## 十、实现优先级

### Phase 1 — 完整 LLM 调用追踪（核心）
- [ ] `parse-session.sh` — Claude Code JSONL 解析（含去重 + 子 Agent）
- [ ] `lib/cost.sh` — 价格表和计费函数
- [ ] `summarize-session.sh` — 从 JSONL 生成 summary.json
- [ ] `update-index.sh` — 维护 `index.json`

### Phase 2 — 多平台支持
- [ ] `lib/platform.sh` — Codex CLI 累积增量解析
- [ ] `lib/platform.sh` — OpenClaw 直接解析
- [ ] 统一 `build-index.sh` 复用 `lib/platform.sh`

### Phase 3 — 增强报告
- [ ] `report.sh` `--detail` 模式（从 session 目录读精细数据）
- [ ] 增加子 Agent 归因报告维度
- [ ] 增加 per-turn 费用排行

---

## 十一、关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 字段命名 | OTel GenAI 语义约定 | 未来对接 Phoenix/Langfuse 零成本，`gen_ai.usage.*` 已是行业事实标准 |
| 去重策略 | `message.id` 唯一约束 | Claude Code 文档明确指出并行工具调用共享 message.id，SDK 源码 `tokens.ts:getAssistantMessageId()` 印证 |
| 子 Agent 归因 | 递归扫描 `subagents/` 目录 | 社区已验证可行，Issue #7881 官方修复前的最佳方案 |
| 存储格式 | JSONL append-only | 容忍进程崩溃，无锁并发写，标准 jq 可直接处理 |
| 计算引擎 | 纯 jq + bc | 零运行时依赖，与现有 build-index.sh 技术栈一致 |
| summary 生成 | 按需重算，不缓存中间态 | 避免缓存失效问题；JSONL 全量扫描对单个 session 足够快 |
| 价格表 | 内嵌 shell case 语句 | 直接参考 `claude-code-main/src/utils/modelCost.ts`，与官方定价同步 |

---

## 十二、Cost Prediction Receipt — `/costea` 预测系统

### 12.1 设计目标

在执行任务前，基于历史数据预估 Token 消耗和费用，以**终端账单（receipt）** 形式呈现给用户确认。支持跨 Provider 费用比较。

### 12.2 预测模型

预测系统有两条路径，按能力递进：

#### 路径 A：LLM 启发式（原始方案）

基于两个数据源：
1. **历史任务索引**（`task-index.json`）：build-index.sh 从三个平台 JSONL 中提取的 per-task 统计
2. **LLM 语义匹配**：/costea 技能由 LLM 分析新任务与历史任务的语义相似度，选取最匹配的 N 条做加权参考

#### 路径 B：ML 预测引擎（`fitting/` 模块，2026-04 新增）

基于机器学习的量化预测，取代纯 LLM 启发式，提供更精确的 P10 / P50 / P90 置信区间：

```
prompt + context
   │
   ├──► extractFeatures + encodeFeatures
   │       18 维 Float64 向量（5 提示形状 + 5 会话位置
   │       + 4 分类索引 + 4 杂项）
   │
   ├──► TF-IDF kNN（余弦相似度 Top-K 检索）
   │       提供可解释性证据（receipt 中的 "类似任务"）
   │
   └──► GBDT 分位数头（15 个 LightGBM .txt 模型）
          learning_rate=0.05, leaves=31, 早停
          纯 JS 推理 ~150µs / 全部 15 个头
```

**ML 预测维度（每个均输出 P10 / P50 / P90）：**

| 目标 | 模型文件 | 说明 |
|------|---------|------|
| `input` | `input_p{10,50,90}.txt` | 输入 Token 数 |
| `output` | `output_p{10,50,90}.txt` | 输出 Token 数 |
| `cache_read` | `cache_read_p{10,50,90}.txt` | 缓存读取 Token |
| `tools` | `tools_p{10,50,90}.txt` | 工具调用次数 |
| `cost` | `cost_p{10,50,90}.txt` | 总费用（USD） |

**评测数据（2769 任务，277 测试集，Sonnet 4.6 定价）：**

| 指标 | 基线启发式 | kNN | GBDT | vs 基线 |
|------|----------:|----:|-----:|--------:|
| cost 中位 APE | 70.9% | 28.1% | **22.2%** | −69% |
| cost ±25% 内 | 31.8% | 43.3% | **54.9%** | +73% |

详见 `fitting/BENCHMARKS.md`。

**设计决策：**
- 预测在 `log1p` 空间进行（Token 用量跨约 6 个数量级）
- 时间切分而非随机切分（避免同 session 泄漏到训练和测试集）
- 纯 JS 推理，无原生绑定、无 ONNX 运行时
- 特征编码器 `encoder.mjs` 与 Python 训练器 `train.py` 严格镜像
- kNN 在 GBDT 路径上仍然运行——提供 receipt 中的历史证据

**LLM 启发式预测维度（兜底）：**

| 维度 | 来源 | 方法 |
|------|------|------|
| Input tokens | 历史匹配 | 匹配任务的 input 中位数/均值 |
| Output tokens | 历史匹配 | 匹配任务的 output 中位数/均值 |
| Tool calls | 历史匹配 | 匹配任务的 tool_calls 均值 |
| Est. runtime | 历史匹配 | 基于 token 总量推算（~1K tok/s API 速度）|
| Confidence | 匹配质量 | 匹配数量 × 语义相似度 × 数据新鲜度 |

**无历史数据时的 Baseline：**

| 任务类型 | Input | Output | Tool Calls | Runtime |
|---------|-------|--------|------------|---------|
| 简单问答 | 5K-15K | 1K-3K | ~5 | ~30s |
| 读文件回答 | 20K-50K | 3K-8K | ~10 | ~1 min |
| 单文件修改 | 30K-80K | 5K-15K | ~15 | ~2 min |
| 技能执行 | 50K-200K | 10K-50K | ~30 | ~5 min |
| 多文件重构 | 100K-500K | 20K-80K | ~50 | ~10 min |
| 大功能实现 | 300K-2M | 50K-200K | ~100+ | ~20 min |

### 12.3 多 Provider 费用比较

`lib/cost.sh` 中的 `COSTEA_PROVIDERS` 数组定义了各 Provider 的 input/output 单价。预测时对同一组 Token 估算值，分别按各 Provider 计费：

```
provider_cost = (est_input × provider.input + est_output × provider.output) / 1,000,000
```

Receipt 展示 Top 3 Provider，标注 `best_provider`（最低价）和 `total_cost`（当前使用的模型费用）。

### 12.4 Receipt 终端渲染

`receipt.sh` 接受结构化 JSON，输出 Unicode box-drawing 的终端账单：

```
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │                  C O S T E A                     │
  │              Agent Cost Receipt                  │
  │             2026-04-08 14:32:07                  │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │  TASK                                            │
  │  Refactor the auth module                        │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │  Input tokens                        12,400      │
  │  Output tokens                        5,800      │
  │  Tool calls                              14      │
  │  Similar tasks matched                    3      │
  │  Est. runtime                        ~2 min      │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │  PROVIDER ESTIMATES                              │
  │  Claude Sonnet 4                        $0.38    │
  │  GPT-5.4                                $0.54    │
  │  Gemini 2.5 Pro                         $0.29    │
  │                                                  │
  │══════════════════════════════════════════════════│
  │                                                  │
  │  ESTIMATED TOTAL                        $0.38    │
  │                    best price: Gemini 2.5 Pro    │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │  Confidence                              96%     │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │            Proceed? [Y/N]                        │
  │                                                  │
  │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
  │                                                  │
  │          POWERED BY /COSTEA SKILL                │
  │        THANK YOU FOR BEING COST-CONSCIOUS        │
  │                                                  │
  │       ║│║║│║│ ║║│║│║│║ ║║│║║│║│║│               │
  │                                                  │
  └──────────────────────────────────────────────────┘
```

**receipt.sh 输入 JSON Schema：**

```json
{
  "task":           "string — 任务描述（截断到 44 字符）",
  "input_tokens":   "number — 预估输入 token",
  "output_tokens":  "number — 预估输出 token",
  "tool_calls":     "number — 预估工具调用次数",
  "similar_tasks":  "number — 匹配到的历史任务数",
  "est_runtime":    "string — 预估运行时间（如 ~2 min）",
  "providers":      "[{name, cost}] — 各 Provider 估算费用",
  "total_cost":     "number — 当前模型的预估总费用",
  "best_provider":  "string — 最低价 Provider 名",
  "confidence":     "number — 置信度百分比（0-100）"
}
```

### 12.5 端到端数据流

```
用户输入 /costea <task>
    ↓
build-index.sh → task-index.json（刷新）
    ↓
estimate-cost.sh "<task>" → JSON{historical_tasks, provider_prices}
    ↓
LLM 语义匹配 + 估算 → receipt JSON
    ↓
receipt.sh < receipt JSON → 终端账单
    ↓
AskUserQuestion → Y/N
    ↓
Y → 执行任务
N → 中止

```

### 12.6 Claude Code Token 计算原理（预测依据）

预测模型的设计直接参考了 Claude Code 内部的 Token 计算流程（`claude-code-main/src`）：

**流式累积（`services/api/claude.ts`）：**
- API 返回流式事件，`message_start` 携带初始 input_tokens，`message_delta` 携带最终 output_tokens
- `updateUsage()` 合并规则：input 类只取 >0 值（避免 delta 事件的 0 覆盖真实值），output 直接更新
- 触发时机：`message_delta` 事件 → `calculateUSDCost()` → `addToTotalSessionCost()`

**计费（`utils/modelCost.ts`）：**
```
cost = input/1M × inputPrice + output/1M × outputPrice
     + cacheRead/1M × cacheReadPrice + cacheWrite/1M × cacheWritePrice
     + webSearchRequests × 0.01
```

**状态累积（`cost-tracker.ts` → `bootstrap/state.ts`）：**
- `STATE.modelUsage[model]` 按模型累积 inputTokens / outputTokens / cacheRead / cacheWrite / costUSD
- `getTotalInputTokens()` = `sumBy(Object.values(STATE.modelUsage), 'inputTokens')`
- 进程退出 → `saveCurrentSessionCosts()` 持久化到 project config → 下次 resume 恢复

**去重（`utils/tokens.ts`）：**
- 并行工具调用拆分为多条 assistant 记录，共享 `message.id`
- `getAssistantMessageId()` 返回 id 用于去重；`tokenCountWithEstimation()` 回溯到同 id 的首条记录

这些内部机制直接决定了 JSONL 文件中 Token 数据的结构，也是 `parse-session.sh` 去重和计费逻辑的基础。
