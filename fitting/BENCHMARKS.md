# Costea fitting — benchmarks

> Last run: 2026-04-15
> Index: `~/.costea/task-index.json`, 2799 raw → 2769 usable tasks
> Split: 80 / 10 / 10 by timestamp → train 2215, val 277, test 277
> Cost target: Sonnet 4.6 prices ($3 in / $15 out / $0.30 cache_read per 1M tokens)
> GBDT bundle: 1028 trees total (15 quantile heads), 47-dim features (v2)
> Features: 18 original + 1 task_type + 12 keyword-group + 16 TF-IDF SVD

Reproduce locally:

```bash
cd fitting
node scripts/eval-baseline.mjs    # current heuristic
node scripts/eval-knn.mjs         # TF-IDF kNN + empirical quantile
node scripts/eval-gbdt.mjs        # bundled boosted-tree heads
node scripts/compare.mjs          # all three, side by side
```

---

## Headline (cost target)

| Metric        | baseline | TF-IDF kNN | **GBDT v2** | Δ vs baseline |
|---------------|---------:|-----------:|------------:|--------------:|
| MAPE          |   407.1% |      37.2% |  **34.5%**  |        −92% |
| median APE    |    70.9% |      28.1% |  **24.0%**  |        −66% |
| log-RMSE      |    1.261 |      0.543 |  **0.514**  |        −59% |
| within ±25%   |    31.8% |      43.3% |  **51.6%**  |        +62% |
| within ±50%   |    41.2% |      71.1% |  **71.5%**  |        +73% |

GBDT v2 wins on all five cost metrics. The `log-RMSE` improvement
(0.536 → 0.514) over the v1 model comes from the 29 new semantic
features (keyword-groups + TF-IDF SVD) which give the trees signal
about task intent, not just prompt shape.

---

## Per-target tables

Bold = best of three.

### cost (USD, Sonnet 4.6)

| Metric | baseline | knn | gbdt v2 |
|---|---:|---:|---:|
| MAPE                | 407.1% | 37.2% | **34.5%** |
| median APE          | 70.9%  | 28.1% | **24.0%** |
| log-RMSE            | 1.261  | 0.543 | **0.514** |
| within ±25%         | 31.8%  | 43.3% | **51.6%** |
| within ±50%         | 41.2%  | 71.1% | **71.5%** |
| P10–P90 coverage    | —      | 59.2% | 59.6% |

### input_tokens

| Metric | baseline | knn | gbdt v2 |
|---|---:|---:|---:|
| MAPE                | 11 024 156.1% | 159.0% | **101.7%** |
| median APE          | 833.3% | 88.0% | **60.1%** |
| log-RMSE            | 6.836  | 1.267 | **1.125** |
| within ±25%         | 6.1%   | 14.4% | **20.9%** |
| within ±50%         | 16.6%  | 31.8% | **42.2%** |
| P10–P90 coverage    | —      | 68.6% | **79.1%** |

### output_tokens

| Metric | baseline | knn | gbdt v2 |
|---|---:|---:|---:|
| MAPE                | 4074.8% | 1241.9% | **720.7%** |
| median APE          | 219.9% | 81.7% | **74.8%** |
| log-RMSE            | 2.280  | 1.700 | **1.527** |
| within ±25%         | 11.2%  | 11.9% | **13.4%** |
| within ±50%         | 18.8%  | 27.8% | **29.6%** |
| P10–P90 coverage    | —      | 82.3% | 80.5% |

### cache_read_tokens

| Metric | baseline | knn | gbdt v2 |
|---|---:|---:|---:|
| MAPE                | 706.0% | 132.2% | **95.2%** |
| median APE          | 89.7%  | 75.7%  | **68.3%** |
| log-RMSE            | 1.869  | 1.670  | **1.564** |
| within ±25%         | 13.7%  | **14.4%** | 13.4% |
| within ±50%         | 24.5%  | 28.9%  | **33.2%** |
| P10–P90 coverage    | —      | 82.3%  | 70.4% |

### tool_calls

| Metric | baseline | knn | gbdt v2 |
|---|---:|---:|---:|
| MAPE                | 603.5% | 143.2% | **141.3%** |
| median APE          | 166.7% | 76.2%  | **68.3%** |
| log-RMSE            | 1.587  | 1.081  | **0.990** |
| within ±25%         | 10.5%  | **17.3%** | 17.0% |
| within ±50%         | 22.4%  | 30.0%  | **32.9%** |
| P10–P90 coverage    | —      | 72.6%  | **76.9%** |

---

## What "GBDT v2" means here

```
prompt + ctx
   │
   ├──► extractFeatures + encodeFeatures
   │       47-dim Float64 vector:
   │         5 prompt-shape + 5 session-position + 4 categorical-index
   │       + 4 misc + 1 task_type + 12 keyword-group binary
   │       + 16 TF-IDF SVD components
   │
   ├──► fitting/models/<target>_<quantile>.txt
   │       LightGBM Booster, quantile objective, learning_rate=0.05,
   │       leaves=31, early stopping on val
   │
   └──► gbdt.mjs: parses the .txt format, walks every tree per query
            (~10 µs / head), aggregates leaf values, applies expm1
            and the same isotonic + conformal calibration as the kNN
            path.
```

The 29 new features give the trees semantic signal about task intent:
- **12 keyword-group features**: regex-detected binary indicators for
  test/refactor/fix/create/read/deploy/doc/config/perf/security/ui/data
- **1 task_type**: coarse classification into 6 categories
- **16 SVD components**: TruncatedSVD on the TF-IDF prompt matrix,
  projection matrix stored in manifest for JS inference

Pure-JS inference. No native bindings, no ONNX runtime, no Python
required at predict-time. The SVD projection at inference is a single
matrix multiply (~0.1 ms). The only Python dependency is at train-time
(`pip install lightgbm scikit-learn` + `brew install libomp` on macOS).

The kNN remains active even on the GBDT path — it provides the top-K
historical evidence shown in receipts and feeds the confidence
proxy.

---

## Validation-set vs test-set coverage (GBDT)

| Target     | Val coverage (post-cal) | Test coverage |
|------------|------------------------:|--------------:|
| input      | 81.9% | 75.5% |
| output     | 82.7% | 79.4% |
| cache_read | 79.4% | 70.4% |
| tools      | 83.4% | 70.8% |
| cost       | 78.0% | 57.8% |

cost coverage drops most on test — a conformal-on-shift symptom we
also see on the kNN bundle. The intervals are well-calibrated on val
but the test slice is the most recent 5 days, where prompt
distribution drifts faster than the calibration set tracks.
Retraining (see below) takes a fresh val slice and recovers
calibration.

---

## Retraining

The bundle in `fitting/models/` was trained at
`2026-04-13T08:44:36+00:00` on whatever was in
`~/.costea/task-index.json` at that moment (2769 tasks). To refresh:

```bash
brew install libomp                       # macOS, once
pip install lightgbm numpy                # once

cd fitting
python3 training/train.py                 # writes into fitting/models/
node scripts/eval-gbdt.mjs                # measure
node scripts/compare.mjs                  # vs other methods
```

Tunables that matter:

```bash
python3 training/train.py --num-trees 400 --leaves 63
```

More trees + wider leaves widen the gap to kNN further at the cost of
a larger bundle. The 919-tree default lands at 2.7 MB total.

After a successful retrain:

```bash
git add fitting/models/*.txt fitting/models/manifest.json
git commit -m "models: retrain on $(date +%Y-%m-%d)"
```

---

## Cost vs runtime

| Stage                                | Latency (laptop, M-series) |
|--------------------------------------|---------------------------:|
| Bundle load (15 .txt files, 919 trees parsed) | ~80 ms (one-shot, on import) |
| Encode one query                     | <0.1 ms |
| GBDT predict (15 heads)              | ~150 µs |
| TF-IDF + kNN evidence path           | ~3 ms |
| Calibration apply                    | <0.1 ms |
| **End-to-end predict (warm)**        | **~3 ms** |

End-to-end budget unchanged from the kNN-only path — both still run;
the GBDT heads are the cheap part.

---

## Reproducibility

Bundle predictions are bit-deterministic given the model files:

```text
sample task row, cost_p50.txt:
  python lgb predict():  0.0638968822208243
  js gbdt.mjs predict(): 0.0638968822208243
```

The Python trainer is seeded on LightGBM defaults; bagging introduces
minor run-to-run variance unless you pin `seed=` and
`feature_fraction_seed=` in the `params` dict in
`training/train.py`.
