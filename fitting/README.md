# @costea/fitting

ML-based token & cost predictor for Costea. See
[`references/design/ml-estimator-design.md`](../references/design/ml-estimator-design.md)
for full architecture.

## Status

Phase 0 (baseline evaluation) and Phase 1 (TF-IDF retrieval + empirical
quantiles + isotonic calibration) implemented. Pure Node.js, no external
dependencies. Real ONNX/MiniLM embeddings drop in at the same interface
later.

## Layout

```
src/
├── data/loader.mjs           Load task-index.json, derive turn_index, time-split
├── features/extract.mjs      Structured feature extraction
├── retrieval/                TF-IDF tokenizer, vectorizer, kNN
├── models/                   Empirical quantile regressor, isotonic calibration
├── metrics/                  MAPE, RMSE, coverage, interval score
└── index.mjs                 Public API: fit() + predict()

scripts/
├── eval-baseline.mjs         Phase 0: how bad is the current heuristic?
├── eval-knn.mjs              Phase 1: how does retrieval do?
├── compare.mjs               Side-by-side report
└── predict.mjs               One-shot CLI prediction
```

## Quick start

```bash
# 1. Make sure you have ~/.costea/task-index.json (run skills/costea/scripts/build-index.sh)
# 2. From this directory:
node scripts/eval-baseline.mjs    # current estimator MAPE on test split
node scripts/eval-knn.mjs         # ML pipeline MAPE on test split
node scripts/compare.mjs          # both, side by side

# Make a single prediction:
node scripts/predict.mjs "refactor the auth middleware to use JWT"
```

## Design notes

- **Targets** are predicted in `log1p` space to handle the heavy tail
  (token usage spans ~6 orders of magnitude in the corpus).
- **Time split**, never random split — same session leaking across
  train/test would inflate accuracy via cache-state leakage.
- **Quantile output** (P10 / P50 / P90) instead of point estimates,
  so receipts can show an honest interval.
- **Zero deps** by design; the embedding layer is swappable but the
  default TF-IDF vectorizer keeps install/runtime minimal.

## Roadmap

- [x] Phase 0 — baseline measurement harness
- [x] Phase 1 — TF-IDF retrieval + empirical quantiles + calibration
- [ ] Phase 2 — LightGBM heads via ONNX (Python training in CI)
- [ ] Phase 3 — Conformal coverage tightening
- [ ] Phase 4 — Online warm-start after each `backfill-estimates.sh`
