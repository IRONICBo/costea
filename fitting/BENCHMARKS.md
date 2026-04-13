# Costea fitting — benchmarks

> Last run: 2026-04-13
> Index: `~/.costea/task-index.json`, 2799 raw → 2769 usable tasks
> Split: 80 / 10 / 10 by timestamp → train 2215, val 277, test 277
> Cost target: Sonnet 4.6 prices ($3 in / $15 out / $0.30 cache_read per 1M tokens)
> GBDT bundle: 919 trees total (15 quantile heads × ~60 trees), 2.7 MB

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

| Metric        | baseline | TF-IDF kNN | **GBDT** | Δ vs baseline |
|---------------|---------:|-----------:|---------:|--------------:|
| MAPE          |   407.1% |      37.2% | **34.7%** |        −91% |
| median APE    |    70.9% |      28.1% | **22.2%** |        −69% |
| log-RMSE      |    1.261 |      0.543 | **0.536** |        −58% |
| within ±25%   |    31.8% |      43.3% | **54.9%** |        +73% |
| within ±50%   |    41.2% |  **71.1%** |    70.4% |        +71% |

The GBDT bundle wins on every cost metric except `within ±50%`, where
the calibrated kNN edges it by 0.7 pp. On the harder `within ±25%`
band — half a receipt's-worth of accuracy — GBDT is +12 pp ahead of
kNN and +23 pp ahead of the production heuristic.

---

## Per-target tables

Bold = best of three.

### cost (USD, Sonnet 4.6)

| Metric | baseline | knn | gbdt |
|---|---:|---:|---:|
| MAPE                | 407.1% | 37.2% | **34.7%** |
| median APE          | 70.9%  | 28.1% | **22.2%** |
| log-RMSE            | 1.261  | 0.543 | **0.536** |
| within ±25%         | 31.8%  | 43.3% | **54.9%** |
| within ±50%         | 41.2%  | **71.1%** | 70.4% |
| P10–P90 coverage    | —      | 59.2% | 57.8% |

### input_tokens

| Metric | baseline | knn | gbdt |
|---|---:|---:|---:|
| MAPE                | 11 024 156.1% | 159.0% | **109.6%** |
| median APE          | 833.3% | 88.0% | **70.0%** |
| log-RMSE            | 6.836  | 1.267 | **1.178** |
| within ±25%         | 6.1%   | 14.4% | **22.4%** |
| within ±50%         | 16.6%  | 31.8% | **38.6%** |
| P10–P90 coverage    | —      | 68.6% | **75.5%** |

### output_tokens

| Metric | baseline | knn | gbdt |
|---|---:|---:|---:|
| MAPE                | 4074.8% | 1241.9% | **815.1%** |
| median APE          | 219.9% | **81.7%** | 82.6% |
| log-RMSE            | 2.280  | **1.700** | 1.794 |
| within ±25%         | 11.2%  | 11.9% | **12.6%** |
| within ±50%         | 18.8%  | **27.8%** | 23.5% |
| P10–P90 coverage    | —      | 82.3% | 79.4% |

### cache_read_tokens

| Metric | baseline | knn | gbdt |
|---|---:|---:|---:|
| MAPE                | 706.0% | 132.2% | **99.4%** |
| median APE          | 89.7%  | 75.7%  | **73.0%** |
| log-RMSE            | 1.869  | **1.670** | 1.727 |
| within ±25%         | 13.7%  | **14.4%** | 13.7% |
| within ±50%         | 24.5%  | **28.9%** | 28.2% |
| P10–P90 coverage    | —      | 82.3%  | 70.4% |

### tool_calls

| Metric | baseline | knn | gbdt |
|---|---:|---:|---:|
| MAPE                | 603.5% | 143.2% | **124.7%** |
| median APE          | 166.7% | 76.2%  | **72.4%** |
| log-RMSE            | 1.587  | 1.081  | **1.040** |
| within ±25%         | 10.5%  | **17.3%** | 14.8% |
| within ±50%         | 22.4%  | 30.0%  | **36.1%** |
| P10–P90 coverage    | —      | 72.6%  | 70.8% |

---

## What "GBDT" means here

```
prompt + ctx
   │
   ├──► extractFeatures + encodeFeatures
   │       18-dim Float64 vector (5 prompt-shape + 5 session-position
   │       + 4 categorical-index + 4 misc)
   │
   ├──► fitting/models/<target>_<quantile>.txt
   │       LightGBM Booster, quantile objective, learning_rate=0.05,
   │       leaves=31, num_trees ≤ 120 with early stopping on val
   │
   └──► gbdt.mjs: parses the .txt format, walks every tree per query
            (~10 µs / head), aggregates leaf values, applies expm1
            and the same isotonic + conformal calibration as the kNN
            path.
```

Pure-JS inference. No native bindings, no ONNX runtime, no Python
required at predict-time. The only Python dependency is at train-time
(`pip install lightgbm` + `brew install libomp` on macOS).

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
