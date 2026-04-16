#!/usr/bin/env python3
"""
Train scikit-learn linear quantile regression heads.

Uses sklearn.linear_model.QuantileRegressor for each (target, quantile)
pair, producing 15 lightweight models whose weights are exported as JSON
(coef + intercept) for trivial JS inference.

Usage
-----

    python3 training/train_linear.py \
        --index ~/.costea/task-index.json \
        --out ~/.costea/models/linear/

Dependencies: scikit-learn>=1.1, numpy.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Import shared feature pipeline from train.py
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).parent))
from train import (
    extract_features,
    annotate_sequence,
    encode_row,
    derive_target,
    time_split,
    costea_tokenize,
    FEATURE_NAMES,
    TARGETS,
    QUANTILES,
    DEFAULT_SOURCES,
    DEFAULT_MODELS,
    DEFAULT_LANGS,
    TASK_TYPES,
    SVD_DIMS,
    KEYWORD_GROUPS,
)

try:
    from sklearn.linear_model import QuantileRegressor
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer as SkTfidf
    from sklearn.preprocessing import StandardScaler
except ImportError as e:
    raise SystemExit(
        "scikit-learn is not installed.  Install with:  pip install scikit-learn"
    ) from e


# ---------------------------------------------------------------------------
# SVD pipeline (reuses costea_tokenize, mirrors train.py)
# ---------------------------------------------------------------------------


def fit_svd(train_prompts, val_prompts, test_prompts):
    """Fit TF-IDF + SVD on training prompts and transform all splits."""
    n_tr = len(train_prompts)
    n_va = len(val_prompts)
    n_te = len(test_prompts)

    print(f"fitting TF-IDF SVD ({SVD_DIMS} components) on {n_tr} prompts...")
    tfidf = SkTfidf(
        max_features=3000,
        sublinear_tf=True,
        min_df=2,
        max_df=0.6,
        analyzer=lambda doc: costea_tokenize(doc),
    )
    X_tfidf_train = tfidf.fit_transform(train_prompts)
    X_tfidf_val = tfidf.transform(val_prompts)
    X_tfidf_test = tfidf.transform(test_prompts)

    svd = TruncatedSVD(n_components=SVD_DIMS, random_state=42)
    svd_train = svd.fit_transform(X_tfidf_train)
    svd_val = svd.transform(X_tfidf_val)
    svd_test = svd.transform(X_tfidf_test)
    explained = svd.explained_variance_ratio_.sum()
    print(f"SVD explained variance: {explained:.1%} ({SVD_DIMS} components)")

    svd_meta = {
        "svd_vocab": tfidf.get_feature_names_out().tolist(),
        "svd_idf": tfidf.idf_.tolist(),
        "svd_components": svd.components_.tolist(),
    }
    return svd_train, svd_val, svd_test, svd_meta


# ---------------------------------------------------------------------------
# Model fitting + export
# ---------------------------------------------------------------------------


def fit_one(X_train: np.ndarray, y_train: np.ndarray, alpha: float):
    """Fit a single quantile regression model."""
    model = QuantileRegressor(quantile=alpha, alpha=0.1, solver="highs")
    model.fit(X_train, y_train)
    return model


def export_weights_json(model, path: str | Path) -> None:
    """Dump linear model weights to a JSON file."""
    data = {
        "coef": model.coef_.tolist(),
        "intercept": float(model.intercept_),
    }
    with open(path, "w") as f:
        json.dump(data, f)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def pinball(y_true: np.ndarray, y_pred: np.ndarray, alpha: float) -> float:
    diff = y_true - y_pred
    return np.where(diff >= 0, alpha * diff, (alpha - 1) * diff).mean()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--index", default=str(Path.home() / ".costea" / "task-index.json")
    )
    ap.add_argument(
        "--out", default=str(Path.home() / ".costea" / "models" / "linear")
    )
    ap.add_argument(
        "--min-tasks",
        type=int,
        default=200,
        help="Bail if fewer usable tasks are available.",
    )
    ap.add_argument(
        "--regularization",
        type=float,
        default=0.1,
        help="L1 regularization strength (alpha param in QuantileRegressor).",
    )
    ap.add_argument(
        "--scale",
        action="store_true",
        help="StandardScaler on features before fitting.",
    )
    args = ap.parse_args()

    index_path = Path(args.index).expanduser()
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- Load tasks ----
    print(f"reading {index_path}")
    with index_path.open() as f:
        idx = json.load(f)
    tasks_raw = idx.get("tasks", [])

    usable = [
        t
        for t in tasks_raw
        if (t.get("token_usage") or {}).get("total", 0) > 0
        and (t.get("user_prompt") or "").strip()
    ]
    if len(usable) < args.min_tasks:
        print(
            f"only {len(usable)} usable tasks (< --min-tasks {args.min_tasks}), aborting"
        )
        return 2

    tasks = annotate_sequence(usable)
    train_tasks, val_tasks, test_tasks = time_split(tasks)
    print(f"train={len(train_tasks)} val={len(val_tasks)} test={len(test_tasks)}")

    # ---- Build feature matrix ----
    skills = sorted(
        {t.get("skill_name") for t in train_tasks if t.get("skill_name")}
    )
    manifest = {
        "version": 2,
        "model_type": "linear",
        "feature_names": FEATURE_NAMES,
        "categorical": {
            "source": DEFAULT_SOURCES,
            "model": DEFAULT_MODELS,
            "lang": DEFAULT_LANGS,
            "skill": skills,
            "task_type": TASK_TYPES,
        },
        "targets": TARGETS,
        "quantiles": [q[0] for q in QUANTILES],
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_train": len(train_tasks),
        "n_val": len(val_tasks),
        "params": {
            "regularization": args.regularization,
            "solver": "highs",
            "scaled": args.scale,
        },
        "svd_dims": SVD_DIMS,
        "files": {},
    }

    feats_train = [extract_features(t) for t in train_tasks]
    feats_val = [extract_features(t) for t in val_tasks]
    feats_test = [extract_features(t) for t in test_tasks]

    train_prompts = [t.get("user_prompt") or "" for t in train_tasks]
    val_prompts = [t.get("user_prompt") or "" for t in val_tasks]
    test_prompts = [t.get("user_prompt") or "" for t in test_tasks]

    svd_train, svd_val, svd_test, svd_meta = fit_svd(
        train_prompts, val_prompts, test_prompts
    )
    manifest.update(svd_meta)

    X_train = np.asarray(
        [
            encode_row(f, manifest, svd_row=svd_train[i])
            for i, f in enumerate(feats_train)
        ],
        dtype=np.float64,
    )
    X_val = np.asarray(
        [
            encode_row(f, manifest, svd_row=svd_val[i])
            for i, f in enumerate(feats_val)
        ],
        dtype=np.float64,
    )
    X_test = np.asarray(
        [
            encode_row(f, manifest, svd_row=svd_test[i])
            for i, f in enumerate(feats_test)
        ],
        dtype=np.float64,
    )

    # Optional scaling
    scaler = None
    if args.scale:
        scaler = StandardScaler()
        X_train = scaler.fit_transform(X_train)
        X_val = scaler.transform(X_val)
        X_test = scaler.transform(X_test)
        manifest["scaler"] = {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
        }

    input_dim = X_train.shape[1]
    print(f"input_dim={input_dim}")

    # ---- Train models ----
    for tgt in TARGETS:
        y_tr = np.log1p(
            np.maximum(0.0, [derive_target(t, tgt) for t in train_tasks])
        )
        y_va = np.log1p(
            np.maximum(0.0, [derive_target(t, tgt) for t in val_tasks])
        )
        y_te = np.log1p(
            np.maximum(0.0, [derive_target(t, tgt) for t in test_tasks])
        )
        manifest["files"][tgt] = {}

        for qname, alpha in QUANTILES:
            print(f"fitting {tgt} {qname} (alpha={alpha})...", end=" ")
            model = fit_one(X_train, y_tr, alpha)

            # Export JSON weights
            json_name = f"{tgt}_{qname}.json"
            export_weights_json(model, out_dir / json_name)
            manifest["files"][tgt][qname] = json_name

            # Evaluate on val and test
            val_pred = model.predict(X_val)
            test_pred = model.predict(X_test)
            val_loss = pinball(y_va, val_pred, alpha)
            test_loss = pinball(y_te, test_pred, alpha)
            print(f"val={val_loss:.4f}  test={test_loss:.4f}")

    # ---- Write manifest ----
    manifest_path = out_dir / "manifest.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nwrote manifest -> {manifest_path}")
    print(f"wrote {len(TARGETS) * len(QUANTILES)} model files into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
