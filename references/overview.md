# Costea 项目参考文档

> 本文档梳理 Costea 项目的整体结构、核心功能与数据流，供开发和维护参考。

---

## 项目概述

Costea 是一套用于追踪和估算 AI 编码工具 Token 消耗的技能插件，支持 Claude Code、Codex CLI 和 OpenClaw 三个平台。核心理念：**执行之前先知道花多少**。

---

## 目录结构

```
costea/
├── LICENSE
├── README.md              # 英文文档
├── README.zh-CN.md        # 中文文档
├── references/            # 参考资料（本文档所在位置）
├── fitting/               # ML 预测引擎（GBDT + kNN）
│   ├── src/
│   │   ├── data/          # 任务索引加载、时间切分
│   │   ├── features/      # 特征提取 + 数值编码器
│   │   ├── retrieval/     # TF-IDF 分词 + 余弦 kNN
│   │   ├── models/        # 经验分位数、等温校准、GBDT 推理
│   │   ├── metrics/       # MAPE、RMSE、覆盖率、Winkler
│   │   └── index.mjs      # Predictor 公共 API
│   ├── models/            # 预训练 LightGBM 权重（15 个分位数头）
│   ├── training/          # Python LightGBM 训练脚本
│   ├── scripts/           # 评估 & 对比脚本
│   ├── tests/             # node:test 测试套件
│   └── BENCHMARKS.md      # 真实语料库评测数据
└── skills/
    ├── costea/            # 任务执行前的费用估算技能
    │   ├── SKILL.md
    │   └── scripts/
    │       ├── build-index.sh     # 扫描所有平台 Session，生成统一索引
    │       ├── estimate-cost.sh   # 检索历史数据，供 LLM 做估算参考
    │       └── analyze-tokens.sh  # OpenClaw 专用的 Session 分析工具
    └── costeamigo/        # 历史消耗报告技能
        ├── SKILL.md
        └── scripts/
            └── report.sh          # 多维度聚合报告生成
```

---

## 两个技能

### `/costea` — 执行前费用估算

**用途：** 在执行任务前，根据历史数据估算本次任务的 Token 花费，并请用户确认再继续。

**用法：**
```
/costea 重构认证模块
```

**工作流（7 步）：**

1. 提取任务描述
2. 运行 `build-index.sh`，扫描并刷新任务索引（< 1 小时则跳过）
3. 运行 `estimate-cost.sh`，检索语义相近的历史任务
4. LLM 分析历史数据，估算：
   - 输入 / 输出 Token 量
   - 缓存命中概率
   - 工具调用次数
   - 推理 vs 工具调用比例
5. 展示费用预估（含置信度：高 / 中 / 低）并询问 Y/N
6. 用户确认后执行任务，或放弃
7. 任务完成后（可选）对比预估值与实际值

---

### `/costeamigo` — 历史消耗报告

**用途：** 生成多维度的历史 Token 消耗聚合分析。

**用法：**
```
/costeamigo            # 交互式选择平台
/costeamigo all        # 所有平台合并
/costeamigo claude     # 仅 Claude Code
/costeamigo codex      # 仅 Codex CLI
/costeamigo openclaw   # 仅 OpenClaw
```

**报告包含：**

| 维度 | 内容 |
|------|------|
| 总览 | 总 Token、总费用、时间范围、来源数量 |
| 按平台 | 各平台 Token / 费用 / 模型 / 任务数 |
| 按技能 | 各 `/skill` 的消耗聚合，含平均值 |
| 按模型 | 各模型的输入 / 输出 / 缓存分布 |
| 按工具 | 工具调用次数排行 |
| 推理 vs 工具 | 推理 Token 与工具调用 Token 的占比 |
| 最贵任务 | Top 5-10 高消耗任务详情 |
| 洞察 | 2-3 条优化建议 |

---

## 支持的平台与数据源

| 平台 | Session 路径 | Token 数据格式 |
|------|-------------|---------------|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | 每条 assistant 消息中的 `usage` 字段 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count` 累积事件 |
| OpenClaw | `~/.openclaw/agents/main/sessions/*.jsonl` | 每条消息的 `usage`，含费用细分 |

---

## 核心脚本说明

### `build-index.sh`

纯 `jq` 实现，无 LLM 调用，100% 确定性。

- **输出：** `~/.costea/task-index.json`
- **功能：**
  - 扫描三个平台的所有 Session 文件
  - 将每条用户消息视为一个独立任务
  - 识别技能调用（OpenClaw: `Use the "xxx" skill`；Claude Code: `/xxx`）
  - 提取每个任务的 Token、费用、工具调用、推理占比
  - Claude Code 支持子智能体：将 subagent Token 累加到父任务

**任务索引结构（简化）：**
```json
{
  "tasks": [{
    "source": "openclaw|claude-code|codex",
    "model": "claude-opus-4",
    "is_skill": true,
    "skill_name": "qa",
    "user_prompt": "任务描述（截断到合理长度）",
    "token_usage": {
      "input": 25000,
      "output": 18000,
      "cache_read": 2000,
      "cache_write": 500,
      "total": 45500
    },
    "cost": { "total": 0.82 },
    "tools": [{"name": "Read", "count": 3}],
    "reasoning": {"tokens": 800, "count": 1},
    "tool_invocation": {"tokens": 850, "count": 1}
  }],
  "task_count": 120,
  "total_tokens": 500000,
  "total_cost": 15.50
}
```

---

### `estimate-cost.sh`

- 检查索引是否存在且新鲜（< 1 小时）
- 过期则自动触发 `build-index.sh` 重建
- 提取任务摘要（前 200 字符），计算推理百分比
- 输出 JSON 供 LLM 做语义匹配和估算

---

### `analyze-tokens.sh`

OpenClaw 专用的 Session 分析工具（非技能直接调用，供开发调试）。

**三级输出：**
1. Session 整体 Token 统计
2. 按工具分摊 Token（按比例）
3. 推理 vs 工具调用的 Token 分布

**模式：**
- 默认：分析最近一次 Session
- `--all`：所有 Session 汇总表
- `--session ID`：指定 Session（前缀匹配）
- `--top N`：限制输出条数
- `--no-color`：禁用彩色输出

---

### `report.sh`

- **输入：** `--source all|openclaw|claude-code|codex`
- **输出：** 结构化 JSON，包含多个分析视图
- 供 `/costeamigo` 技能调用后由 LLM 格式化为可读报告

---

## 数据流

```
三个平台的 Session JSONL 文件
          ↓
    build-index.sh（纯 jq，无 LLM）
          ↓
~/.costea/task-index.json（中央任务数据库）
          ↓
    ┌─────────────────────────────────────┐
    ↓                 ↓                   ↓
/costea          /costeamigo         fitting/
estimate-cost.sh  report.sh         Predictor API
LLM 估算         LLM 格式化报告    GBDT + kNN 量化预测
Y/N 确认后执行   多维度消耗分析    P10/P50/P90 置信区间
```

---

## ML 预测引擎（fitting）

`fitting/` 模块为 Costea 提供基于机器学习的 Token 和费用预测能力，取代纯 LLM 启发式估算。

### 架构

两层管线，预测时纯 Node.js，无需 Python 或原生扩展：

1. **TF-IDF kNN** — 对用户输入做 Latin/CJK 分词和 TF-IDF 向量化，余弦相似度检索 Top-K 最相近的历史任务，提供可解释性证据。
2. **GBDT 分位数头** — 15 个 LightGBM 模型（5 个目标 × 3 个分位数），在 `log1p` 空间做量化预测，纯 JS 解析 `.txt` 模型文件并逐树遍历推理，约 150µs 完成所有 15 个头。

### 目标维度

每个预测输出 P10 / P50 / P90 三个分位数：

| 目标 | 含义 |
|------|------|
| `input` | 输入 Token |
| `output` | 输出 Token |
| `cache_read` | 缓存读取 Token |
| `tools` | 工具调用次数 |
| `cost` | 总费用（USD） |

### 评测数据（真实语料）

2769 个可用任务，277 个时间切分测试集，cost 按 Sonnet 4.6 定价：

| 指标 | 基线 | kNN | GBDT | vs 基线 |
|------|-----:|----:|-----:|--------:|
| cost 中位 APE | 70.9% | 28.1% | **22.2%** | −69% |
| cost ±25% 内 | 31.8% | 43.3% | **54.9%** | +73% |

### 训练流程

训练在 Python 中完成（`fitting/training/train.py`），推理在 JS 中完成（`fitting/src/models/gbdt.mjs`）。特征编码器 `encoder.mjs` 与 `train.py` 严格镜像，通过模型文件的 `feature_names` 行作为契约。

```bash
pip install lightgbm numpy
python3 fitting/training/train.py    # → fitting/models/*.txt
```

---

## 技术细节

### Token 类型

| 字段 | 含义 | 计费 |
|------|------|------|
| `input` | 普通输入 Token | 标准价 |
| `output` | 输出 Token | 标准价（较贵） |
| `cache_read` | 缓存命中（提示缓存） | 折扣价（约 10%） |
| `cache_write` | 缓存写入 | 略高于标准价 |

### 推理 vs 工具调用判断

通过 `stop_reason` 区分：
- `stop` → 推理轮次（extended thinking 完成）
- `toolUse` → 工具调用轮次

### 价格参考（内嵌于技能）

**Claude 系列：**
| 模型 | 输入（/M） | 输出（/M） | 缓存读（/M） | 缓存写（/M） |
|------|-----------|-----------|------------|------------|
| Claude Opus 4.6 | $15 | $75 | $1.50 | $18.75 |
| Claude Sonnet | $3 | $15 | — | — |
| Claude Haiku | $0.80 | $4 | — | — |

**OpenAI 系列：**
| 模型 | 输入（/M） | 输出（/M） |
|------|-----------|-----------|
| GPT-5.4 | $2.50 | $15 |
| GPT-5.2-codex | $1.07 | $8.50 |
| GPT-5.1-codex | $1.07 | $8.50 |

---

## 安装

**依赖：** `jq`（`brew install jq`）

```bash
# Claude Code
ln -s /path/to/costea/skills/costea ~/.claude/skills/costea
ln -s /path/to/costea/skills/costeamigo ~/.claude/skills/costeamigo

# OpenClaw
ln -s /path/to/costea/skills/costea ~/.agents/skills/costea
ln -s /path/to/costea/skills/costeamigo ~/.agents/skills/costeamigo
```
