# Training the boosted-tree heads

The runtime in `src/models/gbdt.mjs` is pure JS — it loads any model
that LightGBM's `Booster.save_model()` produces. This directory holds
the Python script that generates those models.

## Why Python

LightGBM's training code only ships in C++ / Python / R. Inference is
trivial to reimplement (we did, in `gbdt.mjs`); training is not. So
the workflow is:

```
~/.costea/task-index.json   ──▶  python train.py  ──▶  fitting/models/*.txt
                                                          │
                                                          ▼
                                              loaded by Predictor
```

## Setup

```bash
# macOS
brew install libomp
pip install lightgbm numpy

# Linux
pip install lightgbm numpy
```

## Train

```bash
# uses the bundled defaults: ~/.costea/task-index.json,
# writes into fitting/models/
python3 training/train.py

# tune
python3 training/train.py --num-trees 400 --leaves 63

# different index location
python3 training/train.py --index /path/to/task-index.json --out /tmp/my-models
```

The script writes 16 files into the output directory:

```
manifest.json
input_p10.txt   input_p50.txt   input_p90.txt
output_p10.txt  output_p50.txt  output_p90.txt
cache_read_p10.txt cache_read_p50.txt cache_read_p90.txt
tools_p10.txt   tools_p50.txt   tools_p90.txt
cost_p10.txt    cost_p50.txt    cost_p90.txt
```

`manifest.json` records the feature ordering, categorical
vocabularies, training params, and the timestamps. The JS runtime
loads it first, then each `.txt` model on demand.

## Replacing the bundled demo weights

```bash
python3 training/train.py --out fitting/models
git add fitting/models/*.txt fitting/models/manifest.json
git commit -m "models: retrain on $(date +%Y-%m-%d) snapshot"
```

That's it — no rebuild step on the JS side.

## Feature schema

`train.py` mirrors `src/features/extract.mjs` and
`src/features/encoder.mjs` exactly. If you change feature ordering or
add a column on one side, mirror it on the other. The model file's
`feature_names=` line and the manifest's `feature_names` list must
agree with `FEATURE_NAMES` in both files.

The included unit test `tests/encoder.test.mjs` snapshot-checks the
JS encoder; the Python equivalent is checked at training time by
asserting `len(row) == len(FEATURE_NAMES)`.
