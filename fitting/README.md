# @costea/fitting

ML-based token & cost predictor for Costea.

Two layers, both pure Node.js at predict time:

1. **TF-IDF kNN** retrieves the top-K most similar historical tasks.
2. **Boosted-tree heads** (LightGBM, trained in Python, walked in JS)
   produce calibrated P10 / P50 / P90 for input, output, cache_read,
   tool calls, and cost.

The kNN keeps running on every query — its hits are the
explainability evidence shown in receipts. The boosted-tree bundle
drives the actual numbers when present, and the predictor falls back
to empirical kNN quantiles cleanly when it isn't.

## Numbers on the real corpus

2769 usable tasks, 277-task time-split test, cost = Sonnet 4.6 prices:

| Target | Median APE — baseline | TF-IDF kNN | **GBDT** | Δ vs baseline |
|---|---:|---:|---:|---:|
| **cost**   | 70.9% | 28.1% | **22.2%** | −69% |
| input      | 833%  | 88%   | **70%**   | −92% |
| output     | 220%  | 82%   | 83%       | −62% |
| cache_read | 90%   | 76%   | **73%**   | −19% |
| tools      | 167%  | 76%   | **72%**   | −57% |

Cost `within ±25%`: baseline 31.8% → kNN 43.3% → **GBDT 54.9%**.
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
node scripts/compare.mjs          # baseline vs kNN vs GBDT
```

## Retraining the demo weights

```bash
brew install libomp               # macOS only
pip install lightgbm numpy
python3 training/train.py         # writes into fitting/models/
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
