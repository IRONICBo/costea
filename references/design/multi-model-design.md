# Costea 多模型预测架构设计

> 日期：2026-04-16
> 状态：设计完成，实现中
> 前置：GBDT v2（47 维特征，cost medAPE 20.7%）已上线

---

## 1. 目标

在现有 GBDT（LightGBM）基础上扩展多种模型类型，包括轻量级深度学习模型，支持 ONNX 导出，并提供统一的训练、评测、推理和 Web UI 管理能力。

| 模型类型 | 训练框架 | 推理方式 | 导出格式 |
|----------|---------|---------|---------|
| **GBDT** (LightGBM) | lightgbm (Python) | Pure-JS tree walker | .txt |
| **MLP** (多层感知机) | PyTorch (Python) | Pure-JS 矩阵运算 | ONNX + JSON weights |
| **Linear** (岭回归) | scikit-learn (Python) | Pure-JS 点积 | JSON weights |

---

## 2. 架构

### 2.1 模型注册表

```
ModelRegistry
├── gbdt     → GBDTBackend     { load, predict, meta }
├── mlp      → MLPBackend      { load, predict, meta }
└── linear   → LinearBackend   { load, predict, meta }
```

每个 Backend 实现统一接口：

```javascript
interface ModelBackend {
  name: string;                          // "gbdt" | "mlp" | "linear"
  load(dir: string): Promise<Model>;     // 从目录加载模型
  predict(model, x: Float64Array): PredictionSet;  // 单条推理
  meta(model): ModelMeta;                // 模型元信息
}

interface PredictionSet {
  [target: string]: { p10: number, p50: number, p90: number }
}

interface ModelMeta {
  type: string;
  trained_at: string;
  n_train: number;
  feature_count: number;
  params: object;
}
```

### 2.2 目录布局

```
~/.costea/models/
├── manifest.json          # 全局 manifest（指向活跃模型）
├── gbdt/
│   ├── manifest.json      # GBDT 特有 manifest
│   ├── cost_p50.txt       # LightGBM tree files
│   └── ...
├── mlp/
│   ├── manifest.json      # MLP 特有 manifest
│   ├── weights.json       # JSON 权重（Pure-JS 推理用）
│   └── model.onnx         # ONNX 格式（可选，互操作用）
└── linear/
    ├── manifest.json
    └── weights.json       # {coef, intercept} per target×quantile
```

内置模型保持在 `fitting/models/` 下（仅 GBDT，向后兼容）。

### 2.3 向后兼容

现有的 `fitting/models/manifest.json`（GBDT v2）继续作为默认兜底。新的多模型布局是可选增强，不破坏现有安装。

---

## 3. MLP 模型设计

### 3.1 网络结构

```
Input (47 dims)
  → BatchNorm1d
  → Linear(47, 128) → ReLU → Dropout(0.1)
  → Linear(128, 64) → ReLU → Dropout(0.1)
  → Linear(64, 1)
```

每个 (target, quantile) 一个独立的 MLP head，共 15 个模型。
与 GBDT 相同的 log1p 空间训练、pinball loss。

### 3.2 训练参数

| 参数 | 值 |
|------|------|
| optimizer | AdamW |
| learning_rate | 1e-3 |
| weight_decay | 1e-4 |
| batch_size | 64 |
| epochs | 200（early stopping patience=20） |
| loss | Pinball (quantile) loss |
| input normalization | BatchNorm（参数存入权重） |

### 3.3 导出

1. **JSON weights**（主要）: 每层的 weight, bias, bn 参数 → `weights.json`
   - Pure-JS 推理直接加载，零依赖
   - 文件约 100-200 KB

2. **ONNX**（可选互操作）: `torch.onnx.export()` → `model.onnx`
   - 供 onnxruntime-node / onnxruntime-web 使用
   - 供其他生态（TensorRT, CoreML）转换

### 3.4 Pure-JS 推理

```javascript
function forward(x, weights) {
  // x: Float64Array[47]
  let h = batchNormInfer(x, weights.bn);    // (x - mean) / sqrt(var + eps) * gamma + beta
  h = linearForward(h, weights.layers[0]);    // W·h + b
  h = relu(h);
  h = linearForward(h, weights.layers[1]);
  h = relu(h);
  h = linearForward(h, weights.layers[2]);    // output: scalar
  return h[0];
}
```

推理成本：~0.05 ms（47×128 + 128×64 + 64×1 = ~15K 乘加运算）。

---

## 4. Linear 模型设计

### 4.1 方法

Ridge regression（L2 正则化线性回归），scikit-learn `Ridge(alpha=1.0)`。

对于分位数回归，使用 `sklearn.linear_model.QuantileRegressor`。

### 4.2 Pure-JS 推理

```javascript
function predict(x, weights) {
  // weights: { coef: number[47], intercept: number }
  let sum = weights.intercept;
  for (let i = 0; i < x.length; i++) sum += x[i] * weights.coef[i];
  return sum;
}
```

推理成本：~0.001 ms（47 次乘加）。

---

## 5. ONNX 导出流程

```
PyTorch model (MLP)
    ↓ torch.onnx.export()
model.onnx
    ↓ 可选：onnxruntime 验证
    ↓ 同时导出 weights.json（Pure-JS 用）
```

ONNX 文件可用于：
- `onnxruntime-node` 推理（性能更高，但需要原生依赖）
- `onnxruntime-web` 推理（浏览器端）
- 转换到其他运行时（TensorRT, CoreML, TFLite）

Costea 默认使用 JSON weights + Pure-JS 推理，ONNX 作为可选高性能路径。

---

## 6. 训练 CLI

```bash
# 训练所有模型类型
npm run train -- --model all

# 训练指定模型
npm run train -- --model gbdt
npm run train -- --model mlp
npm run train -- --model linear

# MLP 特有参数
npm run train -- --model mlp --epochs 300 --hidden 128,64

# 导出 ONNX
npm run train -- --model mlp --export-onnx
```

### train.py 扩展

```bash
python3 training/train.py --model gbdt    # 现有行为
python3 training/train.py --model mlp     # 新增
python3 training/train.py --model linear  # 新增
python3 training/train.py --model all     # 训练所有
```

---

## 7. 评测对比

```bash
node scripts/compare.mjs    # 自动检测所有可用模型并对比

# 输出：
# ╔═══════════════════════════════════════════════════════════╗
# ║  Costea fitting — multi-model comparison (test split)     ║
# ╚═══════════════════════════════════════════════════════════╝
#                    baseline    knn     gbdt     mlp    linear
# cost  medAPE        70.9%    28.1%   20.7%   xx.x%    xx.x%
# cost  log-RMSE      1.261    0.543   0.492   x.xxx    x.xxx
# ...
```

---

## 8. Web UI 更新

### /settings/training 页面扩展

- 模型类型选择器：GBDT / MLP / Linear / All
- MLP 专有参数：hidden layers, epochs, learning rate
- ONNX 导出开关
- 模型对比视图：各模型在 test split 上的指标并排展示

---

## 9. Predictor 模型选择

```javascript
// 自动选择最佳可用模型
const predictor = await Predictor.fitFromIndex({
  modelType: "auto"  // 默认：按 manifest 中记录的 test 精度自动选
});

// 指定模型类型
const predictor = await Predictor.fitFromIndex({
  modelType: "mlp"
});
```

`auto` 策略：加载所有可用模型的 manifest，比较 `test_metrics.cost.log_rmse`，选最低的。

---

## 10. 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| MLP 推理 | Pure-JS (JSON weights) | 零依赖，与 Costea 哲学一致；ONNX 作可选路径 |
| MLP 结构 | 2 隐层 (128, 64) | 47 维输入不需要更深；过深反而过拟合 |
| 分位数回归 | Pinball loss | 与 GBDT 对齐，输出 P10/P50/P90 |
| Linear 回归 | QuantileRegressor | sklearn 原生支持，训练快 |
| ONNX 导出 | 可选 | 不强制，避免 onnx 包依赖 |
| 多模型目录 | `~/.costea/models/{type}/` | 各类型独立管理，不互相干扰 |
