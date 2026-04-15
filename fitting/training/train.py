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
from collections import Counter

try:
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer as SkTfidf
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

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

SVD_DIMS = 16

# Keyword-group regexes — must mirror src/features/extract.mjs KEYWORD_GROUPS
KEYWORD_GROUPS = [
    ("kw_test",     re.compile(r"\btest|测试|spec|coverage|assert|jest|vitest|mocha", re.I)),
    ("kw_refactor", re.compile(r"\brefactor|重构|rewrite|重写|migrat|迁移|rename|重命名", re.I)),
    ("kw_fix",      re.compile(r"\bfix|修复|bug|error|报错|crash|issue|问题", re.I)),
    ("kw_create",   re.compile(r"\bcreate|创建|implement|实现|add\b|新增|build|构建", re.I)),
    ("kw_read",     re.compile(r"\bread\b|explain|解释|review|审查|analyz|分析|understand|理解", re.I)),
    ("kw_deploy",   re.compile(r"\bdeploy|部署|release|发布|\bci\b|\bcd\b|pipeline|docker", re.I)),
    ("kw_doc",      re.compile(r"\bdoc|文档|readme|comment|注释|changelog", re.I)),
    ("kw_config",   re.compile(r"\bconfig|配置|\benv\b|settings|setup|install|安装", re.I)),
    ("kw_perf",     re.compile(r"\bperf|性能|optimiz|优化|speed|cache|缓存|fast|slow", re.I)),
    ("kw_security", re.compile(r"\bauth|认证|token|permission|权限|security|安全|login|登录", re.I)),
    ("kw_ui",       re.compile(r"\bui\b|界面|\bcss\b|style|component|组件|\bpage|页面|frontend|前端", re.I)),
    ("kw_data",     re.compile(r"\bdatabase|数据库|\bsql\b|query|migration|schema|\btable\b|mongo|\bredis", re.I)),
]

TASK_TYPES = ["skill", "refactor", "feature", "modify", "read", "simple"]

FEATURE_NAMES = [
    # --- original 18 ---
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
    # --- task type (1) ---
    "task_type_idx",
    # --- keyword-group binary (12) ---
    *[name for name, _ in KEYWORD_GROUPS],
    # --- TF-IDF SVD (16) ---
    *[f"svd_{i}" for i in range(SVD_DIMS)],
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


def classify_task_type(prompt: str) -> str:
    d = (prompt or "").lower()
    if re.match(r"^/[a-zA-Z0-9_-]", d):
        return "skill"
    if re.search(r"refactor|重构|rewrite|重写|migrate|迁移", d):
        return "refactor"
    if re.search(r"implement|实现|build|构建|create|创建|add feature|新功能", d):
        return "feature"
    if re.search(r"fix|修复|bug|error|报错|issue", d):
        return "modify"
    if re.search(r"read|看|explain|解释|what|how|为什么|分析|review", d):
        return "read"
    return "simple"


def extract_features(task: dict) -> dict:
    prompt = task.get("user_prompt") or ""
    skill = task.get("skill_name")
    if not skill:
        m = SKILL_RE.match(prompt)
        if m:
            skill = m.group(1)
    hour, weekday = time_features(task.get("timestamp"))

    # keyword-group binary features
    kw_feats = {}
    for name, regex in KEYWORD_GROUPS:
        kw_feats[name] = 1 if regex.search(prompt) else 0

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
        "task_type": classify_task_type(prompt),
        **kw_feats,
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


def encode_row(f: dict, manifest: dict, svd_row=None) -> list[float]:
    cat = manifest["categorical"]
    row = [
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
        # task type
        lookup(cat.get("task_type", TASK_TYPES), f.get("task_type")),
        # keyword-group binary
        *[f.get(name, 0) for name, _ in KEYWORD_GROUPS],
        # SVD components (filled externally)
        *(svd_row.tolist() if svd_row is not None else [0.0] * SVD_DIMS),
    ]
    return row


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


def fit_one(X_train, y_train, X_val, y_val, alpha, num_trees, leaves,
            init_model=None):
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
        init_model=init_model,
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
    ap.add_argument("--init-model", default=None,
                    help="Directory containing existing model files to warm-start from.")
    ap.add_argument("--mode", choices=["full", "incremental"], default="full",
                    help="Training mode (default: full).")
    ap.add_argument("--incremental-trees", type=int, default=50,
                    help="Number of trees to add in incremental mode.")
    args = ap.parse_args()

    index_path = Path(args.index).expanduser()
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    incremental = args.mode == "incremental"
    init_model_dir = None
    old_manifest = None

    if incremental:
        # Default --init-model to --out (train in place).
        init_model_dir = Path(args.init_model).expanduser() if args.init_model else out_dir
        old_manifest_path = init_model_dir / "manifest.json"
        if not old_manifest_path.exists():
            print(f"error: incremental mode requires an existing manifest at {old_manifest_path}")
            return 1
        with old_manifest_path.open() as f:
            old_manifest = json.load(f)
        print(f"incremental mode — warm-starting from {init_model_dir}")
    elif args.init_model:
        init_model_dir = Path(args.init_model).expanduser()

    num_trees = args.incremental_trees if incremental else args.num_trees

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
        "version": 2,
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
        "n_train": len(train),
        "n_val": len(val),
        "params": {"num_trees": num_trees, "leaves": args.leaves, "lr": 0.05},
        "svd_dims": SVD_DIMS,
        "files": {},
    }

    if incremental:
        manifest["mode"] = "incremental"
        manifest["incremental_from"] = str(init_model_dir)
        manifest["previous_trained_at"] = old_manifest.get("trained_at")

    feats_train = [extract_features(t) for t in train]
    feats_val = [extract_features(t) for t in val]

    # --- Fit TF-IDF SVD on training prompts ---
    svd_train = np.zeros((len(train), SVD_DIMS), dtype=np.float64)
    svd_val = np.zeros((len(val), SVD_DIMS), dtype=np.float64)

    if HAS_SKLEARN:
        print(f"fitting TF-IDF SVD ({SVD_DIMS} components) on {len(train)} prompts…")
        train_prompts = [t.get("user_prompt") or "" for t in train]
        val_prompts = [t.get("user_prompt") or "" for t in val]
        tfidf = SkTfidf(
            max_features=3000, sublinear_tf=True,
            min_df=2, max_df=0.6,
            token_pattern=r"(?u)\b\w+\b",
        )
        X_tfidf_train = tfidf.fit_transform(train_prompts)
        X_tfidf_val = tfidf.transform(val_prompts)
        svd = TruncatedSVD(n_components=SVD_DIMS, random_state=42)
        svd_train = svd.fit_transform(X_tfidf_train)
        svd_val = svd.transform(X_tfidf_val)
        explained = svd.explained_variance_ratio_.sum()
        print(f"SVD explained variance: {explained:.1%} ({SVD_DIMS} components)")

        # Store SVD artifacts in manifest for JS inference
        manifest["svd_vocab"] = tfidf.get_feature_names_out().tolist()
        manifest["svd_idf"] = tfidf.idf_.tolist()
        manifest["svd_components"] = svd.components_.tolist()  # [dims × vocab]
    else:
        print("warning: scikit-learn not installed, SVD features will be zeros")
        print("  install with:  pip install scikit-learn")

    X_train = np.asarray(
        [encode_row(f, manifest, svd_row=svd_train[i]) for i, f in enumerate(feats_train)],
        dtype=np.float64,
    )
    X_val = np.asarray(
        [encode_row(f, manifest, svd_row=svd_val[i]) for i, f in enumerate(feats_val)],
        dtype=np.float64,
    )

    for tgt in TARGETS:
        y_tr = np.log1p(np.maximum(0.0, [derive_target(t, tgt) for t in train]))
        y_va = np.log1p(np.maximum(0.0, [derive_target(t, tgt) for t in val]))
        manifest["files"][tgt] = {}
        for qname, alpha in QUANTILES:
            # Resolve warm-start model path for this (target, quantile).
            init_model_path = None
            if init_model_dir is not None:
                candidate = init_model_dir / f"{tgt}_{qname}.txt"
                if candidate.exists():
                    init_model_path = str(candidate)
                elif incremental:
                    print(f"warning: no init model at {candidate}, training from scratch")

            print(f"fitting {tgt} {qname} (alpha={alpha})"
                  + (f" [warm-start]" if init_model_path else ""))
            booster = fit_one(X_train, y_tr, X_val, y_va, alpha, num_trees,
                              args.leaves, init_model=init_model_path)
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
