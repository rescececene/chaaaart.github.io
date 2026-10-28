"""모델 후보 — 학습(numpy·scikit-learn·lightgbm)과 JSON 내보내기. 매 실행은 core.score() 가 같은 계산을 표준 라이브러리로 한다.

fit(kind, X, z, up, cfg, cols, export) → (예측 함수(numpy X → 원점수), spec(JSON) 또는 None)
spec['type'] 은 core.score 가 아는 것:
  zero    늘 0 (기준선 — '방향 신호 없음')
  ridge   z 위치(변동성 단위 수익률) = Σ w·표준화(x)      ← 원점수 단위 'z'
  logit   로그 오즈 = b + Σ w·표준화(x)                  ← 'logodds'
  lgbm_c  LightGBM 분류의 로그 오즈 (나무를 JSON 으로 펼침) ← 'logodds'
  lgbm_r  LightGBM 회귀(huber) z 위치                     ← 'z'
새 방법을 넣으려면: 여기 분기 하나 + core.score 에 계산 한 가지 + train.CANDIDATES 에 등록.
"""
import numpy as np

from . import core

UNIT = {"zero": "z", "ridge": "z", "lgbm_r": "z", "logit": "logodds", "lgbm_c": "logodds"}


def _std_fit(X):
    mu = np.nan_to_num(np.nanmean(X, 0)) if X.shape[1] else np.zeros(0)
    sd = np.nan_to_num(np.nanstd(X, 0), nan=1.0) if X.shape[1] else np.ones(0)
    sd = np.where(sd > 1e-12, sd, 1.0)
    return mu, sd


def _std_apply(X, mu, sd):
    return np.clip(np.nan_to_num((X - mu) / sd), -5, 5)


def _lgb_params(cfg):
    return dict(n_estimators=cfg["n"], learning_rate=cfg.get("lr", 0.03), num_leaves=cfg["leaves"], min_child_samples=cfg["mcs"],
                subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=10.0, verbose=-1, n_jobs=4,
                random_state=7, deterministic=True, force_row_wise=True)


def _flatten(tree_info):
    """LightGBM dump_model 의 나무 하나 → {f,t,d,m,l,r,v} (음수 자식 = ~잎 번호)"""
    f, t, d, m, L, R, V = [], [], [], [], [], [], []

    def walk(node):
        if "split_index" not in node:  # 잎
            V.append(float(node["leaf_value"]))
            return ~(len(V) - 1)
        if node.get("decision_type", "<=") != "<=":
            raise ValueError("숫자 나눔(<=)만 지원")
        k = len(f)
        f.append(int(node["split_feature"]))
        t.append(float(node["threshold"]))
        d.append(1 if node.get("default_left", True) else 0)
        m.append({"None": 0, "Zero": 1, "NaN": 2}.get(node.get("missing_type", "None"), 0))
        L.append(0)
        R.append(0)
        L[k] = walk(node["left_child"])
        R[k] = walk(node["right_child"])
        return k

    root = tree_info["tree_structure"]
    if "split_index" not in root:
        return {"f": [], "t": [], "d": [], "m": [], "l": [], "r": [], "v": [float(root.get("leaf_value", 0.0))]}
    walk(root)
    return {"f": f, "t": t, "d": d, "m": m, "l": L, "r": R, "v": V}


def _export_lgbm(model, cols, kind, X_check):
    dump = model.booster_.dump_model()
    spec = {"type": kind, "cols": list(cols), "trees": [_flatten(ti) for ti in dump["tree_info"]], "init": 0.0}
    # 표준 라이브러리 계산이 LightGBM 과 같은지 확인 (다르면 내보내지 않는다)
    raw = model.predict(X_check, raw_score=True) if kind == "lgbm_c" else model.predict(X_check)
    mine = np.array([core.score(spec, dict(zip(cols, row))) for row in X_check.tolist()])
    err = float(np.max(np.abs(mine - raw))) if len(raw) else 0.0
    if err > 1e-6:
        raise ValueError(f"나무 계산 불일치 {err:.2e}")
    return spec


def fit(kind, X, z, up, cfg, cols, export=False):
    cols = list(cols)
    if kind == "zero":
        return (lambda Xn: np.zeros(len(Xn))), {"type": "zero", "cols": []}
    if kind == "ridge":
        mu, sd = _std_fit(X)
        A = _std_apply(X, mu, sd)
        zc = z - z.mean()  # 절편은 버린다 — 지난 기간의 평균 오르내림(표류)이 위치에 섞이지 않게
        w = np.linalg.solve(A.T @ A + cfg["alpha"] * np.eye(A.shape[1]), A.T @ zc)
        spec = {"type": "ridge", "cols": cols, "mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": 0.0}
        return (lambda Xn: _std_apply(Xn, mu, sd) @ w), spec
    if kind == "logit":
        from sklearn.linear_model import LogisticRegression
        mu, sd = _std_fit(X)
        clf = LogisticRegression(C=cfg["C"], max_iter=400).fit(_std_apply(X, mu, sd), up.astype(int))
        w, b = clf.coef_[0], float(clf.intercept_[0])
        spec = {"type": "logit", "cols": cols, "mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": b}
        return (lambda Xn: _std_apply(Xn, mu, sd) @ w + b), spec
    if kind in ("lgbm_c", "lgbm_r"):
        import lightgbm as lgb
        if kind == "lgbm_c":
            m = lgb.LGBMClassifier(**_lgb_params(cfg)).fit(X, up.astype(int))
            pred = lambda Xn: m.predict(Xn, raw_score=True)  # noqa: E731
        else:
            m = lgb.LGBMRegressor(objective="huber", alpha=1.5, **_lgb_params(cfg)).fit(X, z)
            pred = lambda Xn: m.predict(Xn)  # noqa: E731
        spec = None
        if export:
            idx = np.linspace(0, len(X) - 1, min(400, len(X))).astype(int)
            spec = _export_lgbm(m, cols, kind, X[idx])
        return pred, spec
    raise ValueError(f"모르는 모델 종류: {kind}")
