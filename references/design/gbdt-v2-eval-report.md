# GBDT v2 特征增强评测报告

> 日期：2026-04-15
> 作者：Asklv
> 状态：已验证，模型已合入 `fitting/models/`

---

## 1. 评测目的

验证将 GBDT 输入特征从 18 维扩展到 47 维（新增关键词族二值特征 + 任务类型 + TF-IDF SVD 语义向量）后，预测精度是否有显著提升。

---

## 2. 环境

### 2.1 硬件

| 项目 | 值 |
|------|------|
| 机器 | Apple Silicon (arm64) |
| 操作系统 | macOS 14.7.8 (Sonoma) |

### 2.2 软件依赖

| 组件 | 版本 |
|------|------|
| Python | 3.12.10 (conda-forge, Clang 18.1.8) |
| Node.js | v25.8.1 |
| LightGBM | 4.6.0 |
| scikit-learn | 1.7.1 |
| NumPy | 2.2.6 |
| @costea/fitting | 0.1.0 |

### 2.3 代码版本

```
commit: f1e4088 (fitting: add keyword-group + task-type + TF-IDF SVD features)
branch: main
```

---

## 3. 数据集

### 3.1 数据源

| 项目 | 值 |
|------|------|
| 索引文件 | `~/.costea/task-index.json` |
| 索引构建时间 | 2026-04-10T09:59:11Z |
| 原始任务数 | 2,799 |
| 可用任务数（过滤 total>0 且 prompt 非空） | 2,769 |

### 3.2 平台分布

| 平台 | 任务数 | 占比 |
|------|-------:|-----:|
| Claude Code | 2,402 | 86.7% |
| Codex CLI | 360 | 13.0% |
| OpenClaw | 7 | 0.3% |

### 3.3 模型分布

| 模型 | 任务数 | 占比 |
|------|-------:|-----:|
| claude-sonnet-4-6 | 1,197 | 43.2% |
| claude-opus-4-6 | 1,175 | 42.4% |
| gpt-5.2-codex | 360 | 13.0% |
| claude-haiku-4-5 | 30 | 1.1% |
| gemini-3.1-pro-preview | 7 | 0.3% |

### 3.4 Token 用量分布

| 百分位 | total tokens |
|-------:|-----------:|
| min | 4,807 |
| p25 | 241,245 |
| p50 | 685,528 |
| p75 | 2,671,037 |
| max | 40,152,544 |
| mean | 3,031,244 |

### 3.5 数据切分

时间排序后按 80/10/10 切分（**非随机**，防止同 session 泄漏）：

| 集合 | 任务数 | 用途 |
|------|-------:|------|
| train | 2,215 | 训练 GBDT + 拟合 TF-IDF/SVD |
| val | 277 | early stopping + isotonic 校准 |
| test | 277 | 最终评测（模型从未见过） |

---

## 4. 模型配置

### 4.1 特征 Schema（v2，47 维）

#### 原始特征（18 维，v1 已有）

| # | 特征名 | 类型 | 来源 |
|---|--------|------|------|
| 0 | `prompt_chars` | int | prompt 字符数 |
| 1 | `prompt_words` | int | prompt 词数（空白分词） |
| 2 | `prompt_approx_tokens` | int | 近似 token 数（ASCII÷4 + CJK÷1.7） |
| 3 | `prompt_has_code` | 0/1 | 是否包含 ` ``` ` 代码块 |
| 4 | `prompt_file_path_count` | int | 正则匹配的文件路径数 |
| 5 | `is_skill` | 0/1 | 是否以 `/` 开头的技能调用 |
| 6 | `turn_index` | int | 当前是会话中第几轮（0-based） |
| 7 | `is_first_turn` | 0/1 | 是否第一轮 |
| 8 | `prior_session_input` | int | 本会话此前累积 input tokens |
| 9 | `prior_session_output` | int | 本会话此前累积 output tokens |
| 10 | `prior_session_cache_read` | int | 此前累积 cache_read tokens |
| 11 | `prior_session_total` | int | 此前累积 total tokens |
| 12 | `hour_of_day` | 0-23 | UTC 小时 |
| 13 | `weekday` | 0-6 | 星期几（0=Mon, 6=Sun） |
| 14 | `lang_idx` | cat | 语言检测（latin=0, cjk=1, unknown=2） |
| 15 | `source_idx` | cat | 平台（claude-code=0, codex=1, openclaw=2） |
| 16 | `model_idx` | cat | 模型（sonnet/opus/haiku/gpt 等 10 种） |
| 17 | `skill_idx` | cat | 技能名（训练集中出现的 skill） |

#### 新增：任务类型（1 维）

| # | 特征名 | 类型 | 取值 |
|---|--------|------|------|
| 18 | `task_type_idx` | cat | skill=0, refactor=1, feature=2, modify=3, read=4, simple=5 |

分类逻辑与 baseline `classifyTask()` 一致：正则匹配 prompt 中的关键词，按优先级归入 6 类。

#### 新增：关键词族二值特征（12 维）

| # | 特征名 | 匹配规则 |
|---|--------|---------|
| 19 | `kw_test` | `test\|测试\|spec\|coverage\|assert\|jest\|vitest\|mocha` |
| 20 | `kw_refactor` | `refactor\|重构\|rewrite\|重写\|migrat\|迁移\|rename\|重命名` |
| 21 | `kw_fix` | `fix\|修复\|bug\|error\|报错\|crash\|issue\|问题` |
| 22 | `kw_create` | `create\|创建\|implement\|实现\|add\|新增\|build\|构建` |
| 23 | `kw_read` | `read\|explain\|解释\|review\|审查\|analyz\|分析\|understand\|理解` |
| 24 | `kw_deploy` | `deploy\|部署\|release\|发布\|ci\|cd\|pipeline\|docker` |
| 25 | `kw_doc` | `doc\|文档\|readme\|comment\|注释\|changelog` |
| 26 | `kw_config` | `config\|配置\|env\|settings\|setup\|install\|安装` |
| 27 | `kw_perf` | `perf\|性能\|optimiz\|优化\|speed\|cache\|缓存\|fast\|slow` |
| 28 | `kw_security` | `auth\|认证\|token\|permission\|权限\|security\|安全\|login\|登录` |
| 29 | `kw_ui` | `ui\|界面\|css\|style\|component\|组件\|page\|页面\|frontend\|前端` |
| 30 | `kw_data` | `database\|数据库\|sql\|query\|migration\|schema\|table\|mongo\|redis` |

每个关键词组使用**大小写不敏感正则**匹配 prompt，命中为 1，否则为 0。中英文关键词混合覆盖。推理成本：12 次正则匹配，约 0.01ms。

#### 新增：TF-IDF SVD 语义向量（16 维）

| # | 特征名 | 说明 |
|---|--------|------|
| 31-46 | `svd_0` .. `svd_15` | TF-IDF 矩阵经 TruncatedSVD 降维后的 16 维稠密向量 |

**训练阶段（Python）：**
1. `sklearn.feature_extraction.text.TfidfVectorizer`（max_features=3000, sublinear_tf, min_df=2, max_df=0.6）拟合训练集 prompts
2. `sklearn.decomposition.TruncatedSVD`（n_components=16, random_state=42）拟合 TF-IDF 矩阵
3. 词汇表（3,000 词）、IDF 权重、投影矩阵（16×3000）存入 `manifest.json`

**推理阶段（JS）：**
1. 使用 `tokenizer.mjs` 分词 + 计数
2. 用 manifest 中的 IDF 权重构建 TF-IDF 行向量
3. L2 归一化
4. 矩阵乘法投影到 16 维（稀疏优化，只计算非零项）

SVD 解释方差比：**23.5%**（16 个主成分捕获了训练集 TF-IDF 方差的 23.5%）。

### 4.2 LightGBM 训练参数

| 参数 | 值 |
|------|------|
| objective | quantile |
| alpha | 0.1 / 0.5 / 0.9（对应 P10/P50/P90） |
| learning_rate | 0.05 |
| num_leaves | 31 |
| min_data_in_leaf | 10 |
| feature_fraction | 0.85 |
| bagging_fraction | 0.85 |
| bagging_freq | 1 |
| num_boost_round | 200（上限，early stopping 通常在 15-123 轮停止） |
| early_stopping_rounds | 20 |
| 目标空间 | log1p（所有 target 在 log1p 空间训练，推理后 expm1 回转） |

### 4.3 模型输出

| 项目 | 值 |
|------|------|
| 模型文件总数 | 16（15 个 .txt 量化头 + manifest.json） |
| 量化头 | 5 targets × 3 quantiles = 15 |
| 树总数 | 1,028（15 个头，每头平均 ~69 棵树） |
| manifest 大小 | ~1.5 MB（含 3000×16 SVD 投影矩阵） |
| .txt 模型文件总大小 | ~2.7 MB |

### 4.4 后处理

| 步骤 | 方法 |
|------|------|
| 反变换 | `Math.expm1(prediction)` 从 log1p 空间回到原始单位 |
| 分位数单调性 | 强制 P10 ≤ P50 ≤ P90（交叉时取排序后的 min/mid/max） |
| P50 等温校准 | 在 val 集上拟合 isotonic regression（PAV 算法） |
| 区间宽度校准 | 在 val 集上搜索 conformal widening factor（目标覆盖 80%） |

---

## 5. 预测目标

每个目标独立训练 3 个量化头（P10、P50、P90），所有预测在 **log1p 空间**完成。

| 目标 | 含义 | 单位 |
|------|------|------|
| `input` | 输入 token 数 | tokens |
| `output` | 输出 token 数 | tokens |
| `cache_read` | 缓存读取 token 数 | tokens |
| `tools` | 工具调用次数 | 次 |
| `cost` | 总费用 | USD（按 Sonnet 4.6 定价：$3/M in, $15/M out, $0.30/M cache_read） |

---

## 6. 评测指标

| 指标 | 含义 | 方向 |
|------|------|------|
| **MAPE** | Mean Absolute Percentage Error | 越低越好 |
| **median APE** | 中位数绝对百分比误差 | 越低越好（比 MAPE 抗极端值） |
| **log-RMSE** | log 空间的 RMSE | 越低越好（**最可靠的全局指标**） |
| **within ±25%** | 预测值在实际值 ±25% 内的比例 | 越高越好 |
| **within ±50%** | 预测值在实际值 ±50% 内的比例 | 越高越好 |
| **P10-P90 coverage** | 实际值落入 [P10, P90] 区间的比例 | 目标 80% |
| **interval score** | Winkler 区间评分 | 越低越好（惩罚区间外 + 区间宽度） |

---

## 7. 评测结果

### 7.1 三路对比：Baseline vs kNN vs GBDT v2

#### cost（USD，Sonnet 4.6 定价）

| 指标 | Baseline | kNN | **GBDT v2** | vs Baseline |
|------|--------:|---------:|----------:|-----------:|
| MAPE | 407.1% | 37.2% | **34.5%** | −91.5% |
| median APE | 70.9% | 28.1% | **24.0%** | −66.1% |
| log-RMSE | 1.2614 | 0.5429 | **0.5137** | −59.3% |
| within ±25% | 31.8% | 43.3% | **51.6%** | +19.8pp |
| within ±50% | 41.2% | 71.1% | **71.5%** | +30.3pp |
| P10-P90 cov | — | 59.2% | **59.6%** | — |

#### input tokens

| 指标 | Baseline | kNN | **GBDT v2** | vs Baseline |
|------|--------:|---------:|----------:|-----------:|
| MAPE | 11,024,156% | 159.0% | **101.7%** | −100% |
| median APE | 833.3% | 88.0% | **60.1%** | −92.8% |
| log-RMSE | 6.8365 | 1.2675 | **1.1253** | −83.5% |
| within ±25% | 6.1% | 14.4% | **20.9%** | +14.8pp |
| within ±50% | 16.6% | 31.8% | **42.2%** | +25.6pp |
| P10-P90 cov | — | 68.6% | **79.1%** | — |

#### output tokens

| 指标 | Baseline | kNN | **GBDT v2** | vs Baseline |
|------|--------:|---------:|----------:|-----------:|
| MAPE | 4,074.8% | 1,241.9% | **720.7%** | −82.3% |
| median APE | 219.9% | 81.7% | **74.8%** | −66.0% |
| log-RMSE | 2.2799 | 1.7002 | **1.5270** | −33.0% |
| within ±25% | 11.2% | 11.9% | **13.4%** | +2.2pp |
| within ±50% | 18.8% | 27.8% | **29.6%** | +10.8pp |
| P10-P90 cov | — | 82.3% | **80.5%** | — |

#### cache_read tokens

| 指标 | Baseline | kNN | **GBDT v2** | vs Baseline |
|------|--------:|---------:|----------:|-----------:|
| MAPE | 706.0% | 132.2% | **95.2%** | −86.5% |
| median APE | 89.7% | 75.7% | **68.3%** | −23.9% |
| log-RMSE | 1.8695 | 1.6697 | **1.5640** | −16.3% |
| within ±25% | 13.7% | **14.4%** | 13.4% | −0.3pp |
| within ±50% | 24.5% | 28.9% | **33.2%** | +8.7pp |
| P10-P90 cov | — | **82.3%** | 70.4% | — |

#### tool calls

| 指标 | Baseline | kNN | **GBDT v2** | vs Baseline |
|------|--------:|---------:|----------:|-----------:|
| MAPE | 603.5% | 143.2% | **141.3%** | −76.6% |
| median APE | 166.7% | 76.2% | **68.3%** | −59.0% |
| log-RMSE | 1.5867 | 1.0808 | **0.9901** | −37.6% |
| within ±25% | 10.5% | **17.3%** | 17.0% | +6.5pp |
| within ±50% | 22.4% | 30.0% | **32.9%** | +10.5pp |
| P10-P90 cov | — | 72.6% | **76.9%** | — |

### 7.2 GBDT v1 (18 维) vs GBDT v2 (47 维)

以下为**同一 test split 上的直接对比**（v1 数据从评测历史记录中获取）：

#### log-RMSE（最可靠全局指标）

| Target | v1 (18 维) | **v2 (47 维)** | 改善 |
|--------|----------:|---------------:|-----:|
| cost | 0.5358 | **0.5137** | **−4.1%** |
| input | 1.1780 | **1.1253** | **−4.5%** |
| output | 1.7940 | **1.5270** | **−14.9%** |
| cache_read | 1.7270 | **1.5640** | **−9.4%** |
| tools | 1.0400 | **0.9901** | **−4.8%** |

**所有 5 个目标的 log-RMSE 都下降了。** output 和 cache_read 改善幅度超过 10%。

#### median APE

| Target | v1 (18 维) | **v2 (47 维)** | 变化 |
|--------|----------:|---------------:|-----:|
| cost | **22.2%** | 24.0% | +1.8pp |
| input | 70.0% | **60.1%** | **−9.9pp** |
| output | 82.6% | **74.8%** | **−7.8pp** |
| cache_read | 73.0% | **68.3%** | **−4.7pp** |
| tools | 72.4% | **68.3%** | **−4.1pp** |

cost median APE 从 22.2% 微升到 24.0%（+1.8pp），但 log-RMSE 更好（0.536→0.514），说明 v2 在尾部极端值上改善更大，中位数点估计略松。其余 4 个 target 的 median APE 全部改善。

#### within ±25%

| Target | v1 (18 维) | **v2 (47 维)** | 变化 |
|--------|----------:|---------------:|-----:|
| cost | **54.9%** | 51.6% | −3.3pp |
| input | **22.4%** | 20.9% | −1.5pp |
| output | 12.6% | **13.4%** | +0.8pp |
| cache_read | 13.7% | 13.4% | −0.3pp |
| tools | 14.8% | **17.0%** | +2.2pp |

### 7.3 校准器状态

| Target | widthFactor | val coverage → after |
|--------|------:|-------:|
| cost | 1.1 | 76.2% → 83.4% |
| input | 1.1 | 74.7% → 79.4% |
| output | 1.0 | 77.3% → 77.3% |
| cache_read | 1.1 | 75.8% → 80.5% |
| tools | 1.0 | 74.7% → 74.7% |

---

## 8. 推理性能

| 阶段 | 耗时 |
|------|-----:|
| Bundle 加载（15 .txt + manifest 解析） | ~100 ms（首次） |
| SVD 词汇表 Map 构建（3000 词） | ~1 ms（首次） |
| 特征提取 + 关键词匹配 | <0.1 ms |
| SVD 投影（稀疏矩阵乘法） | ~0.1 ms |
| GBDT 推理（15 个头） | ~0.15 ms |
| TF-IDF + kNN 证据路径 | ~3 ms |
| 校准应用 | <0.1 ms |
| **端到端 predict（warm）** | **~3.5 ms** |

与 v1 相比，增加的 SVD 投影约 0.1ms，整体延迟从 ~3ms 到 ~3.5ms，不影响用户体验。

---

## 9. 结论

### 9.1 特征增强有效

47 维特征的 GBDT v2 在 **log-RMSE**（最可靠的全局误差指标）上**全部 5 个目标都优于** v1（18 维）：

- cost: −4.1%
- input: −4.5%
- output: **−14.9%**
- cache_read: **−9.4%**
- tools: −4.8%

v2 同时在绝大多数指标上超过了 kNN 基线，确认 GBDT 路径是 Costea 预测引擎的正确方向。

### 9.2 cost median APE 的微回退

cost 的 median APE 从 22.2% 上升到 24.0%（+1.8pp），是唯一一个不及 v1 的 median APE 指标。但 log-RMSE 更低（0.536→0.514），MAPE 也更低（34.7%→34.5%），说明 v2 的整体误差分布更优——**中位数略松但大偏差减少了**。

可能原因：新特征为部分任务提供了更好的区分，但也引入了少量噪声，使得某些"之前碰巧预测准的"任务现在略有偏移。这是特征空间扩展的正常代价。

### 9.3 后续改进方向

| 方向 | 预期收益 | 复杂度 |
|------|---------|--------|
| 增大 SVD 维度到 32 | 捕获更多语义方差（当前 23.5%） | 低 |
| kNN 邻居统计回灌 GBDT | 让树模型参考检索结果 | 中 |
| CJK 专用分词器（jieba） | 提升中文 prompt 的 SVD 质量 | 中 |
| 区间覆盖率专项优化 | test coverage 从 60-80% 拉到稳定 80% | 高 |
| 更多训练数据（>5000 tasks） | 减少 train/test 分布漂移 | 等待自然积累 |

---

## 10. 复现命令

```bash
# 环境准备
pip install lightgbm scikit-learn numpy
brew install libomp    # macOS only

# 训练（输出到临时目录）
cd fitting
python3 training/train.py \
  --index ~/.costea/task-index.json \
  --out /tmp/costea-eval-model \
  --num-trees 200 --leaves 31

# 评测单方法
node scripts/eval-gbdt.mjs --models=/tmp/costea-eval-model

# 三路对比
node scripts/compare.mjs

# 单次预测
node scripts/predict.mjs "refactor the auth middleware to use JWT"
```
