"""模拟负片生成: 从已知正片场景出发, 经胶片模型得到带色罩的扫描图。

用于在没有真实扫描件时验证整条链路: 正片目标已知 -> 模拟曝光 ->
校准 -> 转正 -> 与目标对比(chart 命令)。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# 几种典型片基色罩(扫描空间)
BASES = {
    "orange": (0.86, 0.52, 0.22),
    "warm":   (0.90, 0.60, 0.33),
    "cool":   (0.78, 0.55, 0.35),
}

BORDER = 24  # 未曝光片边宽度(px)


def make_scene(w: int = 640, h: int = 480) -> tuple[np.ndarray, dict]:
    """构造已知目标颜色的正片场景: 灰阶 + 主要色块 + 渐变背景。"""
    rng = np.random.default_rng(0)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = 0.15 + 0.35 * (xx / w) + 0.1 * (yy / h)  # 柔和渐变背景
    img = np.stack([img, img * 0.9 + 0.05, img * 0.8 + 0.08], axis=-1)
    img += rng.normal(0, 0.005, img.shape).astype(np.float32)
    img = np.clip(img, 0, 1)

    targets = {"size": [w, h], "patches": []}

    def patch(name, x, y, pw, ph, rgb):
        img[y:y + ph, x:x + pw] = rgb
        targets["patches"].append({"name": name, "rect": [x, y, pw, ph],
                                   "rgb": [round(float(c), 4) for c in rgb]})

    # 灰阶: 8 级
    n = 8
    pw, ph = 56, 56
    for i in range(n):
        v = 0.06 + 0.88 * i / (n - 1)
        patch(f"gray{i}", 40 + i * (pw + 8), 40, pw, ph, (v, v, v))
    # 主要色块
    colors = {
        "red": (0.75, 0.15, 0.12), "green": (0.20, 0.60, 0.20),
        "blue": (0.15, 0.25, 0.70), "cyan": (0.20, 0.65, 0.65),
        "magenta": (0.65, 0.20, 0.55), "yellow": (0.85, 0.75, 0.15),
        "skin": (0.80, 0.57, 0.45), "foliage": (0.35, 0.45, 0.18),
    }
    for j, (name, rgb) in enumerate(colors.items()):
        patch(name, 40 + (j % 4) * (pw + 8), 140 + (j // 4) * (ph + 12), pw, ph, rgb)
    # 参考灰块(校准用, 目标 0.18)与黑/白块
    patch("ref_gray", 40, 300, 80, 80, (0.18, 0.18, 0.18))
    patch("white", 140, 300, 80, 80, (0.96, 0.96, 0.96))
    patch("black", 240, 300, 80, 80, (0.02, 0.02, 0.02))
    return img.astype(np.float32), targets


def expose(positive: np.ndarray, base_rgb: tuple, ev: float = 0.0,
           film_gamma: float = 1.6, noise: float = 0.004,
           stains: int = 0, seed: int = 0) -> np.ndarray:
    """正片 -> 模拟负片扫描图。

    ev: 曝光量(档), 越大负片越密(扫描图越暗)。
    stains: 片边污点数量(暗斑, 用于演示取样剔除)。
    """
    rng = np.random.default_rng(seed)
    base = np.asarray(base_rgb, dtype=np.float32)
    # 透射率不可能超过 1(未曝光), 负曝光补偿时也要截断
    t = np.clip((1.0 - positive) ** film_gamma * (2.0 ** -ev), 1e-4, 1.0)
    neg = base * t
    # 未曝光片边 = 片底色
    neg[:BORDER, :] = base
    neg[-BORDER:, :] = base
    neg[:, :BORDER] = base
    neg[:, -BORDER:] = base
    # 片边污点: 随机暗斑
    h, w = neg.shape[:2]
    for _ in range(stains):
        cx = int(rng.choice([rng.integers(0, BORDER), rng.integers(w - BORDER, w),
                             rng.integers(0, w)]))
        cy = int(rng.choice([rng.integers(0, BORDER), rng.integers(h - BORDER, h)]))
        r = int(rng.integers(3, 9))
        yy, xx = np.mgrid[max(0, cy - r):cy + r, max(0, cx - r):cx + r]
        mask = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
        ch = int(rng.integers(0, 3))
        region = neg[max(0, cy - r):cy + r, max(0, cx - r):cx + r, ch]
        region[mask] *= float(rng.uniform(0.4, 0.75))
    neg += rng.normal(0, noise, neg.shape).astype(np.float32)
    return np.clip(neg, 0, 1).astype(np.float32)


def generate_roll(outdir: str | Path, frames: int = 3, base: str = "orange",
                  evs: list[float] | None = None, stains: int = 0) -> Path:
    """生成一整卷模拟负片 + 已知目标文件 targets.json。"""
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    positive, targets = make_scene()
    evs = evs if evs is not None else [0.0, 0.7, -0.3][:frames]
    base_rgb = BASES[base]
    for i in range(frames):
        ev = evs[i % len(evs)]
        neg = expose(positive, base_rgb, ev=ev, stains=stains, seed=i)
        from .imgio import save_image
        save_image(neg, out / f"frame_{i:02d}.png")
    targets["base_rgb"] = list(base_rgb)
    targets["border"] = BORDER
    (out / "targets.json").write_text(json.dumps(targets, ensure_ascii=False, indent=2))
    return out
