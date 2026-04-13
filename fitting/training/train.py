#!/usr/bin/env python3
"""
Train the boosted-tree quantile heads consumed by @costea/fitting.

Mirrors the JS feature encoder in src/features/encoder.mjs. Column
ordering, categorical vocabularies, and the time-based split are
identical so models trained here drop into the JS runtime without
re-encoding at inference.

Usage
-----

    # default — train on ~/.costea/task-index.json,
    # write models into fitting/models/
    python3 training/train.py

    # custom paths
    python3 training/train.py \
        --index ~/.costea/task-index.json \
        --out fitting/models/ \
        --num-trees 200 \
        --leaves 31

After training, @costea/fitting will pick up the new manifest.json /
*.txt files automatically. To distribute, just commit the contents of
the chosen output directory.

Dependencies: lightgbm>=4.0, numpy.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    import lightgbm as lgb
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "lightgbm is not installed. Install with:  pip install lightgbm\n"
        "On macOS you also need libomp:  brew install libomp"
    ) from e


# ---------------------------------------------------------------------------
# Schema — keep in lock-step with src/features/encoder.mjs
# ---------------------------------------------------------------------------

FEATURE_NAMES = [
    "prompt_chars",
    "prompt_words",
    "prompt_approx_tokens",
    "prompt_has_code",
    "prompt_file_path_count",
    "is_skill",
    "turn_index",
    "is_first_turn",
    "prior_session_input",
    "prior_session_output",
    "prior_session_cache_read",
    "prior_session_total",
    "hour_of_day",
    "weekday",
    "lang_idx",
    "source_idx",
    "model_idx",
    "skill_idx",
]

DEFAULT_SOURCES = ["claude-code", "codex", "openclaw", "unknown"]
DEFAULT_MODELS = [
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
    "claude-opus-4-5", "claude-sonnet-4",
    "gpt-5.4", "gpt-5.2-codex",
    "gemini-2.5-pro", "gemini-2.5-flash",
    "unknown",
]
DEFAULT_LANGS = ["latin", "cjk", "unknown"]

TARGETS = ["input", "output", "cache_read", "tools", "cost"]
QUANTILES = [("p10", 0.1), ("p50", 0.5), ("p90", 0.9)]

# Sonnet 4.6 prices, mirroring src/index.mjs PROVIDERS[0].
COST_PRICES = {"input": 3.0, "output": 15.0, "cache_read": 0.30}


# ---------------------------------------------------------------------------
# Feature extraction — must match src/features/extract.mjs
# ---------------------------------------------------------------------------

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
SKILL_RE = re.compile(r"^/([a-zA-Z0-9_-]+)")
FILE_PATH_RE = re.compile(r"(?:^|[\s`'\"(])([\w./-]+\.[a-zA-Z]{1,6})(?=$|[\s`'\")]|:)")
CODE_FENCE = "```"


def detect_lang(text: str) -> str:
    if not text:
        return "unknown"
    cjk = ascii_ = 0
    for ch in text:
        if CJK_RE.match(ch):
            cjk += 1
        elif ord(ch) < 128:
            ascii_ += 1
    if cjk == 0 and ascii_ == 0:
        return "unknown"
    return "cjk" if cjk > ascii_ else "latin"


def approx_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = sum(1 for ch in text if CJK_RE.match(ch))
    other = len(text) - cjk
    return round(cjk / 1.7 + other / 4)


def time_features(ts: str) -> tuple[int, int]:
    if not ts:
        return -1, -1
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return -1, -1
    # Mon=0..Sun=6 to match the JS encoder.
    return dt.hour, (dt.weekday())


def extract_features(task: dict) -> dict:
    prompt = task.get("user_prompt") or ""
    skill = task.get("skill_name")
    if not skill:
        m = SKILL_RE.match(prompt)
        if m:
            skill = m.group(1)
    hour, weekday = time_features(task.get("timestamp"))
    return {
        "prompt_chars": len(prompt),
        "prompt_words": len([w for w in prompt.strip().split() if w]),
        "prompt_approx_tokens": approx_tokens(prompt),
        "prompt_has_code": 1 if CODE_FENCE in prompt else 0,
        "prompt_file_path_count": len(FILE_PATH_RE.findall(prompt)),
        "is_skill": 1 if (task.get("is_skill") or prompt.startswith("/")) else 0,
        "skill_name": skill,
        "source": task.get("source"),
        "model": task.get("model"),
        "turn_index": task.get("turn_index", 0),
        "is_first_turn": 1 if task.get("turn_index", 0) == 0 else 0,
        "prior_session_input": task.get("prior_session_input", 0),
        "prior_session_output": task.get("prior_session_output", 0),
        "prior_session_cache_read": task.get("prior_session_cache_read", 0),
        "prior_session_total": task.get("prior_session_total", 0),
        "hour_of_day": hour,
        "weekday": weekday,
        "prompt_lang": detect_lang(prompt),
    }


def annotate_sequence(tasks: list[dict]) -> list[dict]:
    """Sort by session, assign turn_index + prior_session_*."""
    by_session: dict[str, list[dict]] = {}
    for t in tasks:
        by_session.setdefault(t.get("session_id") or "_orphan", []).append(t)
    out = []
    for group in by_session.values():
        group.sort(key=lambda x: x.get("timestamp") or "")
        prev = {"input": 0, "output": 0, "cache_read": 0, "total": 0}
        for i, t in enumerate(group):
            tu = t.get("token_usage") or {}
            t = dict(t)
            t["turn_index"] = i
            t["prior_session_input"] = prev["input"]
            t["prior_session_output"] = prev["output"]
            t["prior_session_cache_read"] = prev["cache_read"]
            t["prior_session_total"] = prev["total"]
            out.append(t)
            prev["input"] += tu.get("input", 0)
            prev["output"] += tu.get("output", 0)
            prev["cache_read"] += tu.get("cache_read", 0)
            prev["total"] += tu.get("total", 0)
    out.sort(key=lambda x: x.get("timestamp") or "")
    return out


# ---------------------------------------------------------------------------
# Encoding — must match src/features/encoder.mjs
# ---------------------------------------------------------------------------


def lookup(vocab: list[str], value):
    if value is None:
        return -1
    try:
        return vocab.index(value)
    except ValueError:
        return -1


def encode_row(f: dict, manifest: dict) -> list[float]:
    cat = manifest["categorical"]
    return [
        f["prompt_chars"],
        f["prompt_words"],
        f["prompt_approx_tokens"],
        f["prompt_has_code"],
        f["prompt_file_path_count"],
        f["is_skill"],
        f["turn_index"],
        f["is_first_turn"],
        f["prior_session_input"],
        f["prior_session_output"],
        f["prior_session_cache_read"],
        f["prior_session_total"],
        f["hour_of_day"],
        f["weekday"],
        lookup(cat["lang"], f["prompt_lang"]),
        lookup(cat["source"], f["source"]),
        lookup(cat["model"], f["model"]),
        lookup(cat["skill"], f["skill_name"]),
    ]


def derive_target(task: dict, target: str) -> float:
    tu = task.get("token_usage") or {}
    if target == "tools":
        return float(task.get("total_tool_calls") or 0)
    if target == "cost":
        return (
            tu.get("input", 0) * COST_PRICES["input"]
            + tu.get("output", 0) * COST_PRICES["output"]
            + tu.get("cache_read", 0) * COST_PRICES["cache_read"]
        ) / 1_000_000
    return float(tu.get(target) or 0)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def time_split(tasks: list[dict], train_ratio=0.8, val_ratio=0.1):
    n = len(tasks)
    a = int(n * train_ratio)
    b = int(n * (train_ratio + val_ratio))
    return tasks[:a], tasks[a:b], tasks[b:]


def fit_one(X_train, y_train, X_val, y_val, alpha, num_trees, leaves):
    train_set = lgb.Dataset(X_train, y_train, free_raw_data=False)
    val_set = lgb.Dataset(X_val, y_val, reference=train_set, free_raw_data=False)
    params = {
        "objective": "quantile",
        "alpha": alpha,
        "metric": "quantile",
        "learning_rate": 0.05,
        "num_leaves": leaves,
        "min_data_in_leaf": 10,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.85,
        "bagging_freq": 1,
        "verbose": -1,
    }
    booster = lgb.train(
        params,
        train_set,
        num_boost_round=num_trees,
        valid_sets=[val_set],
        callbacks=[lgb.early_stopping(stopping_rounds=20), lgb.log_evaluation(period=0)],
    )
    return booster


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", default=str(Path.home() / ".costea" / "task-index.json"))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "models"))
    ap.add_argument("--num-trees", type=int, default=200)
    ap.add_argument("--leaves", type=int, default=31)
    ap.add_argument("--min-tasks", type=int, default=200,
                    help="Bail if fewer usable tasks are available.")
    args = ap.parse_args()

    index_path = Path(args.index).expanduser()
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"reading {index_path}")
    with index_path.open() as f:
        idx = json.load(f)
    tasks_raw = idx.get("tasks", [])

    usable = [
        t for t in tasks_raw
        if (t.get("token_usage") or {}).get("total", 0) > 0
        and (t.get("user_prompt") or "").strip()
    ]
    if len(usable) < args.min_tasks:
        print(f"only {len(usable)} usable tasks (< --min-tasks {args.min_tasks}), aborting")
        return 2

    tasks = annotate_sequence(usable)
    train, val, test = time_split(tasks)
    print(f"train={len(train)} val={len(val)} test={len(test)}")

    skills = sorted({t.get("skill_name") for t in train if t.get("skill_name")})
    manifest = {
        "version": 1,
        "feature_names": FEATURE_NAMES,
        "categorical": {
            "source": DEFAULT_SOURCES,
            "model": DEFAULT_MODELS,
            "lang": DEFAULT_LANGS,
            "skill": skills,
        },
        "targets": TARGETS,
        "quantiles": [q[0] for q in QUANTILES],
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_train": len(train),
        "n_val": len(val),
        "params": {"num_trees": args.num_trees, "leaves": args.leaves, "lr": 0.05},
        "files": {},
    }

    feats_train = [extract_features(t) for t in train]
    feats_val = [extract_features(t) for t in val]
    X_train = np.asarray([encode_row(f, manifest) for f in feats_train], dtype=np.float64)
    X_val = np.asarray([encode_row(f, manifest) for f in feats_val], dtype=np.float64)

    for tgt in TARGETS:
        y_tr = np.log1p(np.maximum(0.0, [derive_target(t, tgt) for t in train]))
        y_va = np.log1p(np.maximum(0.0, [derive_target(t, tgt) for t in val]))
        manifest["files"][tgt] = {}
        for qname, alpha in QUANTILES:
            print(f"fitting {tgt} {qname} (alpha={alpha})")
            booster = fit_one(X_train, y_tr, X_val, y_va, alpha, args.num_trees, args.leaves)
            fname = f"{tgt}_{qname}.txt"
            booster.save_model(str(out_dir / fname))
            manifest["files"][tgt][qname] = fname

    manifest_path = out_dir / "manifest.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nwrote manifest → {manifest_path}")
    print(f"wrote {len(TARGETS) * len(QUANTILES)} model files into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
