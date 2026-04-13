# Costea fitting — benchmarks

> Last run: 2026-04-13
> Index: `~/.costea/task-index.json`, 2799 raw → 2769 usable tasks
> Split: 80 / 10 / 10 by timestamp → train 2215, val 277, test 277
> Cost target: Sonnet 4.6 prices ($3 in / $15 out / $0.30 cache_read per 1M tokens)

Reproduce locally:

```bash
cd fitting
node scripts/eval-baseline.mjs    # current heuristic
node scripts/eval-knn.mjs         # ML pipeline
node scripts/compare.mjs          # both, side by side
```

---

## Headline

| Target     | Metric        | Baseline | ML (Phase 1) | Δ relative |
|------------|---------------|---------:|-------------:|-----------:|
| **cost**   | MAPE          |   407.1% |        37.2% |    −90.9%  |
| **cost**   | median APE    |    70.9% |        28.1% |    −60.4%  |
| **cost**   | log-RMSE      |    1.261 |        0.543 |    −56.9%  |
| **cost**   | within ±25%   |    31.8% |        43.3% |    +36.2%  |
| **cost**   | within ±50%   |    41.2% |        71.1% |    +72.6%  |
| input      | MAPE          | 11024156% |       159.0% |    huge    |
| input      | median APE    |   833.3% |        88.0% |    −89.4%  |
| output     | median APE    |   219.9% |        81.7% |    −62.8%  |
| cache_read | median APE    |    89.7% |        75.7% |    −15.6%  |
| tools      | median APE    |   166.7% |        76.2% |    −54.3%  |

The ML pipeline beats the production heuristic on **every metric for every
target**. Cost is the biggest win because it benefits from log-space
quantile averaging across all four token dimensions simultaneously.

---

## Full per-target tables

### cost (USD, Sonnet 4.6)

| Metric            | Baseline | ML    |
|-------------------|---------:|------:|
| MAPE              | 407.1%   | 37.2% |
| median APE        | 70.9%    | 28.1% |
| log-RMSE          | 1.261    | 0.543 |
| within ±25%       | 31.8%    | 43.3% |
| within ±50%       | 41.2%    | 71.1% |
| P10–P90 coverage  | —        | 59.2% (target 80%) |
| Winkler IS@0.2    | —        | 22.6  |

### input_tokens

| Metric            | Baseline      | ML       |
|-------------------|--------------:|---------:|
| MAPE              | 11 024 156.1% | 159.0%   |
| median APE        | 833.3%        | 88.0%    |
| log-RMSE          | 6.836         | 1.267    |
| within ±25%       | 6.1%          | 14.4%    |
| within ±50%       | 16.6%         | 31.8%    |
| P10–P90 coverage  | —             | 68.6%    |

### output_tokens

| Metric            | Baseline | ML       |
|-------------------|---------:|---------:|
| MAPE              | 4074.8%  | 1241.9%  |
| median APE        | 219.9%   | 81.7%    |
| log-RMSE          | 2.280    | 1.700    |
| within ±25%       | 11.2%    | 11.9%    |
| within ±50%       | 18.8%    | 27.8%    |
| P10–P90 coverage  | —        | 82.3%    |

### cache_read_tokens

| Metric            | Baseline | ML     |
|-------------------|---------:|-------:|
| MAPE              | 706.0%   | 132.2% |
| median APE        | 89.7%    | 75.7%  |
| log-RMSE          | 1.869    | 1.670  |
| within ±25%       | 13.7%    | 14.4%  |
| within ±50%       | 24.5%    | 28.9%  |
| P10–P90 coverage  | —        | 82.3%  |

### tool_calls

| Metric            | Baseline | ML     |
|-------------------|---------:|-------:|
| MAPE              | 603.5%   | 143.2% |
| median APE        | 166.7%   | 76.2%  |
| log-RMSE          | 1.587    | 1.081  |
| within ±25%       | 10.5%    | 17.3%  |
| within ±50%       | 22.4%    | 30.0%  |
| P10–P90 coverage  | —        | 72.6%  |

---

## What the ML pipeline is

```
prompt
  ├──► TF-IDF (sublinear TF, smoothed IDF, L2)         vocab 14 795 terms
  │       Latin words + CJK character bigrams, stopwords dropped
  │
  ├──► Brute-force cosine kNN (k=10) over train set    ~1 ms/query
  │       + skill_name boost +0.15
  │       + same-source boost +0.05
  │       + linear recency decay over 30 days, weight 0.05
  │
  ├──► Empirical weighted P10/P50/P90 on log1p(y)      per-target
  │       weights = score (cosine + boost), floored at 0.05
  │
  └──► Calibration (val-fit, applied at test):
          isotonic regression on (log P50, log actual)
          + multiplicative width factor for [P10,P90] coverage

         Per-target width factors learnt from val:
           input      f=1.3   coverage 74.4 → 79.8 %
           output     f=1.5   coverage 63.2 → 79.8 %
           cache_read f=1.5   coverage 66.8 → 80.5 %
           tools      f=1.2   coverage 75.8 → 79.1 %
           cost       f=1.4   coverage 69.0 → 79.8 %
```

---

## Strategy mix on the test split

The current production heuristic falls into four strategies depending on
how much history matched the prompt. On the 277-task test slice:

| Strategy | Count | Share |
|----------|------:|------:|
| `weighted_similar`     | 200 | 72.2% |
| `recent_p90_30d`       |  50 | 18.1% |
| `blend_match_baseline` |  27 |  9.7% |
| `hardcoded_baseline`   |   0 |  0.0% |

So the supposed "high-confidence" path (`weighted_similar`, ≥3 keyword
matches) covered nearly three quarters of the test set and **still
delivered a 71% median cost APE**. That is the case the ML pipeline
needed to beat — and does, at 28%.

---

## Validation-set coverage vs test-set coverage

| Target     | Val coverage (post-cal) | Test coverage |
|------------|------------------------:|--------------:|
| input      | 79.8% | 68.6% |
| output     | 79.8% | 82.3% |
| cache_read | 80.5% | 82.3% |
| tools      | 79.1% | 72.6% |
| cost       | 79.8% | 59.2% |

Test coverage matches val coverage on output / cache_read, dips slightly
for input / tools, and falls noticeably for cost. This is the standard
conformal-on-shift symptom — the test slice is more recent and our
prompt distribution drifts. Phase 2 (LightGBM heads with model
versioning + shadow mode) is exactly where this gets fixed.

---

## What the wins are *not*

A few caveats worth keeping in mind:

1. **The corpus is biased toward Claude Code (87%).** Codex predictions
   share the same vectorizer / regressor but its 13% slice has heavier
   tails; per-source MAPE breakdowns are a Phase 2 chart.
2. **The test split spans roughly 5 days (Apr 8–13).** Drift across
   longer horizons is not measured here.
3. **Cost is computed at Sonnet 4.6 prices**, not the per-task model
   actually used. For Opus/GPT-4 we'd need a per-target retrofit.
4. **The "input" MAPE absurdity (11M%)** comes from one task with
   `actual_input=2` (the `costea` invocation itself) and a baseline
   prediction in the tens of thousands. Single APE = 5000× then averages
   in. The median APE is the honest number; same caveat applies to the
   ML side at 159% MAPE / 88% median.

---

## Cost vs runtime

| Stage | Latency (laptop, M-series) |
|-------|---------------------------:|
| TF-IDF fit (2.2K docs)            | ~110 ms |
| Vectorise one query               | <1 ms   |
| kNN search (k=10) over 2.2K       | <1 ms   |
| Empirical quantile per target     | <0.1 ms |
| Calibration apply                 | <0.1 ms |
| **End-to-end predict**            | **~3 ms** |

Well under the 100 ms target the design doc set for the Web API.

---

## Reproducibility

```bash
$ cd fitting
$ node scripts/compare.mjs
```

All scripts are deterministic given the index. The TF-IDF vocab,
kNN ranks, and isotonic blocks are reproducible across runs.
