# @costea/fitting

ML-based token & cost predictor for Costea.

Multi-model architecture, all pure Node.js at predict time:

1. **TF-IDF kNN** retrieves the top-K most similar historical tasks
   (explainability evidence for receipts).
2. **GBDT** (LightGBM, trained in Python, walked in JS) — best
   overall log-RMSE, robust to tail outliers.
3. **MLP** (PyTorch, trained in Python, pure-JS forward pass) — best
   median APE, exports to ONNX for interop.
4. **Linear** (sklearn QuantileRegressor, pure-JS dot product) — fast
   baseline, minimal dependencies.

The Predictor auto-selects the best available model or accepts an
explicit `modelType` override. All models produce calibrated
P10 / P50 / P90 intervals for input, output, cache_read, tool calls,
and cost.

## Numbers on the real corpus

2769 usable tasks, 277-task time-split test, cost = Sonnet 4.6 prices:

| cost metric | baseline | kNN | GBDT | MLP | Linear |
|---|---:|---:|---:|---:|---:|
| median APE | 70.9% | 28.1% | 20.7% | **19.1%** | 22.7% |
| log-RMSE | 1.261 | 0.543 | **0.492** | 0.524 | 0.604 |
| within ±25% | 31.8% | 43.3% | 55.6% | **58.5%** | 52.3% |

MLP wins median APE (19.1%), GBDT wins log-RMSE (0.492).
Full table and methodology in [`BENCHMARKS.md`](./BENCHMARKS.md).

## Layout

```
src/
├── data/loader.mjs              Load task-index.json, time-split, session sequencing
├── features/
│   ├── extract.mjs              Structured feature extraction
│   └── encoder.mjs              Float64 encoding shared with Python trainer
├── retrieval/                   TF-IDF tokenizer, vectorizer, kNN
├── models/
│   ├── empirical.mjs            kNN-empirical quantile regressor (fallback)
│   ├── calibration.mjs          Isotonic + conformal width adjustment
│   ├── gbdt.mjs                 Pure-JS LightGBM .txt walker
│   └── bundle.mjs               Loads manifest.json + all quantile heads
├── metrics/                     MAPE, RMSE, coverage, Winkler interval score
└── index.mjs                    Public Predictor API

scripts/
├── eval-baseline.mjs            Score the current estimator.ts heuristic
├── eval-knn.mjs                 Score the TF-IDF kNN pipeline
├── eval-gbdt.mjs                Score the bundled boosted-tree heads
├── compare.mjs                  Three-way side-by-side report
└── predict.mjs                  One-shot CLI prediction

models/                          Bundled demo weights — replace by retraining
├── manifest.json
├── cost_p{10,50,90}.txt
├── input_p{10,50,90}.txt
├── output_p{10,50,90}.txt
├── cache_read_p{10,50,90}.txt
└── tools_p{10,50,90}.txt

training/
├── train.py                     Python LightGBM trainer (mirrors the JS encoder)
└── README.md                    Install + retrain instructions
```

## Quick start

```bash
# 1. Make sure ~/.costea/task-index.json exists
#    (run skills/costea/scripts/build-index.sh)
# 2. From this directory:
node scripts/predict.mjs "refactor the auth middleware to use JWT"
node scripts/compare.mjs          # baseline vs kNN vs GBDT vs MLP vs Linear
```

## Training

```bash
# Prerequisites
brew install libomp               # macOS only
pip install lightgbm numpy scikit-learn torch

# Train individual models
npm run train                     # GBDT (default)
npm run train:mlp                 # MLP (PyTorch)
npm run train:linear              # Linear (sklearn)
npm run train:all                 # All three

# Train with ONNX export
node scripts/train.mjs --model mlp --export-onnx

# Custom parameters
node scripts/train.mjs --model mlp --epochs 300 --hidden 256,128
node scripts/train.mjs --model gbdt --num-trees 400 --leaves 63
```

See [`training/README.md`](./training/README.md) for tunables.

## Design notes

- **Targets** are predicted in `log1p` space to handle the heavy tail
  (token usage spans ~6 orders of magnitude in the corpus).
- **Time split**, never random split — same session leaking across
  train/test would inflate accuracy via cache-state leakage.
- **Quantile output** (P10 / P50 / P90) instead of point estimates,
  so receipts can show an honest interval.
- **Pure-JS inference** for the GBDT path — no native bindings, no
  ONNX runtime. Inference cost is ~150 µs across all 15 heads.
- **Schema is centralised** in `src/features/encoder.mjs` and
  `training/train.py` — the model file's `feature_names` line is the
  contract between them.
