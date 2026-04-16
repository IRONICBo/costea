#!/usr/bin/env python3
"""
Train PyTorch MLP quantile heads with optional ONNX export.

Mirrors the same feature pipeline as train.py (GBDT trainer), producing one
MLP per (target, quantile) = 15 models total.  Weights are exported as JSON
for pure-JS inference and optionally as ONNX.

Usage
-----

    python3 training/train_mlp.py \
        --index ~/.costea/task-index.json \
        --out ~/.costea/models/mlp/ \
        --epochs 200 --hidden 128,64 --export-onnx

Dependencies: torch, numpy, scikit-learn (for TF-IDF SVD).
"""

from __future__ import annotations

import argparse
import json
import math
import os
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
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, TensorDataset
except ImportError as e:
    raise SystemExit(
        "PyTorch is not installed.  Install with:  pip install torch"
    ) from e

try:
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer as SkTfidf

    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class QuantileMLP(nn.Module):
    def __init__(self, input_dim: int = 47, hidden: list[int] | None = None):
        super().__init__()
        if hidden is None:
            hidden = [128, 64]
        self.input_dim = input_dim
        self.hidden = hidden
        self.bn = nn.BatchNorm1d(input_dim)
        self.layers = nn.ModuleList()
        dims = [input_dim] + hidden + [1]
        for i in range(len(dims) - 1):
            self.layers.append(nn.Linear(dims[i], dims[i + 1]))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.bn(x)
        for i, layer in enumerate(self.layers):
            h = layer(h)
            if i < len(self.layers) - 1:  # no activation on last layer
                h = F.relu(h)
        return h.squeeze(-1)


# ---------------------------------------------------------------------------
# Pinball (quantile) loss
# ---------------------------------------------------------------------------


def pinball_loss(
    pred: torch.Tensor, actual: torch.Tensor, alpha: float
) -> torch.Tensor:
    diff = actual - pred
    return torch.where(diff >= 0, alpha * diff, (alpha - 1) * diff).mean()


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------


def export_weights_json(model: QuantileMLP, path: str | Path) -> None:
    """Dump MLP weights to a JSON file consumable by a pure-JS runtime."""
    model.eval()
    data = {
        "architecture": {
            "input_dim": model.input_dim,
            "hidden": model.hidden,
            "output_dim": 1,
        },
        "bn": {
            "weight": model.bn.weight.detach().cpu().tolist(),
            "bias": model.bn.bias.detach().cpu().tolist(),
            "running_mean": model.bn.running_mean.detach().cpu().tolist(),
            "running_var": model.bn.running_var.detach().cpu().tolist(),
            "eps": model.bn.eps,
        },
        "layers": [
            {
                "weight": layer.weight.detach().cpu().tolist(),
                "bias": layer.bias.detach().cpu().tolist(),
            }
            for layer in model.layers
        ],
    }
    with open(path, "w") as f:
        json.dump(data, f)


def export_onnx(model: QuantileMLP, path: str | Path, input_dim: int = 47) -> None:
    """Export the model to ONNX format."""
    model.eval()
    dummy = torch.randn(1, input_dim)
    torch.onnx.export(
        model,
        dummy,
        str(path),
        input_names=["features"],
        output_names=["prediction"],
    )


# ---------------------------------------------------------------------------
# SVD pipeline (reuses costea_tokenize, mirrors train.py)
# ---------------------------------------------------------------------------


def fit_svd(train_prompts, val_prompts, test_prompts):
    """Fit TF-IDF + SVD on training prompts and transform all splits."""
    n_tr = len(train_prompts)
    n_va = len(val_prompts)
    n_te = len(test_prompts)

    svd_train = np.zeros((n_tr, SVD_DIMS), dtype=np.float64)
    svd_val = np.zeros((n_va, SVD_DIMS), dtype=np.float64)
    svd_test = np.zeros((n_te, SVD_DIMS), dtype=np.float64)
    svd_meta = {}

    if not HAS_SKLEARN:
        print("warning: scikit-learn not installed, SVD features will be zeros")
        return svd_train, svd_val, svd_test, svd_meta

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

    svd_meta["svd_vocab"] = tfidf.get_feature_names_out().tolist()
    svd_meta["svd_idf"] = tfidf.idf_.tolist()
    svd_meta["svd_components"] = svd.components_.tolist()

    return svd_train, svd_val, svd_test, svd_meta


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------


def train_one_model(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    alpha: float,
    input_dim: int,
    hidden: list[int],
    epochs: int,
    batch_size: int,
    patience: int,
    device: torch.device,
) -> QuantileMLP:
    model = QuantileMLP(input_dim=input_dim, hidden=hidden).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)

    X_tr_t = torch.tensor(X_train, dtype=torch.float32, device=device)
    y_tr_t = torch.tensor(y_train, dtype=torch.float32, device=device)
    X_va_t = torch.tensor(X_val, dtype=torch.float32, device=device)
    y_va_t = torch.tensor(y_val, dtype=torch.float32, device=device)

    train_ds = TensorDataset(X_tr_t, y_tr_t)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)

    best_val_loss = float("inf")
    best_state = None
    wait = 0

    for epoch in range(1, epochs + 1):
        # --- train ---
        model.train()
        for xb, yb in train_loader:
            optimizer.zero_grad()
            pred = model(xb)
            loss = pinball_loss(pred, yb, alpha)
            loss.backward()
            optimizer.step()

        # --- validate ---
        model.eval()
        with torch.no_grad():
            val_pred = model(X_va_t)
            val_loss = pinball_loss(val_pred, y_va_t, alpha).item()

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            wait = 0
        else:
            wait += 1
            if wait >= patience:
                break

    # restore best weights
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--index", default=str(Path.home() / ".costea" / "task-index.json")
    )
    ap.add_argument("--out", default=str(Path.home() / ".costea" / "models" / "mlp"))
    ap.add_argument("--epochs", type=int, default=200)
    ap.add_argument("--hidden", default="128,64", help="Comma-separated hidden dims")
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--patience", type=int, default=20)
    ap.add_argument(
        "--min-tasks",
        type=int,
        default=200,
        help="Bail if fewer usable tasks are available.",
    )
    ap.add_argument(
        "--export-onnx", action="store_true", help="Also export ONNX files"
    )
    args = ap.parse_args()

    hidden = [int(d) for d in args.hidden.split(",")]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

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
        "model_type": "mlp",
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
            "hidden": hidden,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "patience": args.patience,
            "lr": 1e-3,
            "weight_decay": 1e-4,
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

    input_dim = X_train.shape[1]
    print(f"input_dim={input_dim}  hidden={hidden}")

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
            print(f"training {tgt} {qname} (alpha={alpha})...")
            model = train_one_model(
                X_train,
                y_tr,
                X_val,
                y_va,
                alpha=alpha,
                input_dim=input_dim,
                hidden=hidden,
                epochs=args.epochs,
                batch_size=args.batch_size,
                patience=args.patience,
                device=device,
            )

            # Export JSON weights
            json_name = f"{tgt}_{qname}.json"
            export_weights_json(model, out_dir / json_name)
            manifest["files"][tgt][qname] = json_name

            # Export ONNX (optional)
            if args.export_onnx:
                onnx_name = f"{tgt}_{qname}.onnx"
                export_onnx(model.cpu(), out_dir / onnx_name, input_dim=input_dim)
                manifest["files"][tgt][f"{qname}_onnx"] = onnx_name
                model.to(device)

            # Quick test-set eval
            model.eval()
            with torch.no_grad():
                X_te_t = torch.tensor(X_test, dtype=torch.float32, device=device)
                y_te_t = torch.tensor(y_te, dtype=torch.float32, device=device)
                test_pred = model(X_te_t)
                test_loss = pinball_loss(test_pred, y_te_t, alpha).item()
            print(f"  test pinball loss: {test_loss:.4f}")

    # ---- Write manifest ----
    manifest_path = out_dir / "manifest.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nwrote manifest -> {manifest_path}")
    print(f"wrote {len(TARGETS) * len(QUANTILES)} model files into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
