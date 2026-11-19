"""生成本地全景拼接演示素材。

合成一张 2000x500 的宽景"风景"(渐变天空/地面 + 大量几何纹理),
按 640x480 裁切出 4 张带重叠区域的照片, 分别施加不同曝光,
再生成 1 张与任何照片都无重叠关系的噪声图, 放在序列中间。

所有素材由 OpenCV/numpy 在本地合成, 不下载任何外部资源。
运行: python3 -m scripts.generate_samples
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

OUT_DIR = Path(__file__).resolve().parent.parent / "samples" / "demo"
PANORAMA_W, PANORAMA_H = 2000, 500
CROP_W, CROP_H = 640, 480
CROP_STEP = 453          # 相邻裁切起点间距 -> 重叠约 187px
RNG = np.random.default_rng(20261120)


def build_panorama() -> np.ndarray:
    """绘制一张内容丰富、特征点充足的合成宽景。"""
    img = np.zeros((PANORAMA_H, PANORAMA_W, 3), np.uint8)

    # 天空: 深蓝到浅蓝的纵向渐变; 地面: 绿色渐变
    for y in range(PANORAMA_H):
        if y < 280:
            t = y / 280
            color = (
                int(180 - 60 * t),   # B
                int(130 + 40 * t),   # G
                int(90 + 90 * t),    # R
            )
        else:
            t = (y - 280) / (PANORAMA_H - 280)
            color = (
                int(70 + 30 * t),
                int(120 - 35 * t),
                int(60 + 20 * t),
            )
        img[y, :] = color

    # 地平线附近的远山(多边形)
    ridge = np.array(
        [[0, 280]] +
        [[x, int(280 - 55 - 40 * np.sin(x * 0.011) - 25 * np.sin(x * 0.03))]
         for x in range(0, PANORAMA_W + 1, 20)] +
        [[PANORAMA_W, 280]],
        dtype=np.int32,
    )
    cv2.fillPoly(img, [ridge], (110, 100, 95))

    # 棋盘格条带: 高频纹理, 保证 SIFT 特征充足
    for x in range(0, PANORAMA_W, 24):
        for y in range(300, 348, 24):
            if (x // 24 + y // 24) % 2 == 0:
                cv2.rectangle(img, (x, y), (x + 23, y + 23), (200, 200, 200), -1)

    # 随机散布的房屋(矩形+三角顶)、树木(圆+杆)、路标
    for _ in range(26):
        x = int(RNG.integers(20, PANORAMA_W - 60))
        y = int(RNG.integers(300, 420))
        bw, bh = int(RNG.integers(30, 60)), int(RNG.integers(35, 70))
        wall = tuple(int(c) for c in RNG.integers(60, 220, size=3))
        roof = tuple(int(c) for c in RNG.integers(40, 160, size=3))
        cv2.rectangle(img, (x, y), (x + bw, y + bh), wall, -1)
        cv2.polylines(
            img,
            [np.array([(x - 6, y), (x + bw // 2, y - 22), (x + bw + 6, y)],
                      np.int32)],
            False, roof, 3,
        )
        cv2.rectangle(
            img, (x + bw // 4, y + bh // 2),
            (x + 3 * bw // 4, y + bh), (40, 40, 40), -1,
        )

    for _ in range(40):
        x = int(RNG.integers(10, PANORAMA_W - 10))
        y = int(RNG.integers(250, 330))
        r = int(RNG.integers(8, 20))
        cv2.circle(img, (x, y), r, tuple(int(c) for c in RNG.integers(30, 120, 3)), -1)
        cv2.line(img, (x, y + r), (x, y + r + 18), (40, 30, 20), 3)

    # 彩色圆点与十字标记, 进一步提升可区分性
    for _ in range(120):
        x = int(RNG.integers(0, PANORAMA_W))
        y = int(RNG.integers(0, PANORAMA_H))
        r = int(RNG.integers(3, 9))
        color = tuple(int(c) for c in RNG.integers(0, 255, size=3))
        cv2.circle(img, (x, y), r, color, -1)
        cv2.circle(img, (x, y), r, (20, 20, 20), 1)

    for x in range(100, PANORAMA_W, 170):
        y = int(RNG.integers(40, 220))
        cv2.drawMarker(
            img, (x, y), (30, 30, 220), cv2.MARKER_CROSS, 26, 2
        )

    return img


def crop_photo(panorama: np.ndarray, x0: int) -> np.ndarray:
    crop = panorama[0:CROP_H, x0:x0 + CROP_W].copy()
    # 轻微高斯噪声, 模拟真实相机
    noise = RNG.normal(0, 4, crop.shape).astype(np.float32)
    return np.clip(crop.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def apply_exposure(bgr: np.ndarray, gain: float, tint: tuple[float, float, float]) -> np.ndarray:
    """gain: 整体曝光倍数; tint: BGR 三通道微调。"""
    scale = np.array(tint, np.float32) * gain
    out = bgr.astype(np.float32) * scale
    return np.clip(out, 0, 255).astype(np.uint8)


def make_unmatched() -> np.ndarray:
    """与其它照片毫无共同内容的噪声图, 保证匹配失败。"""
    h, w = CROP_H, CROP_W
    noise = RNG.normal(128, 48, (h, w, 3))
    img = np.clip(noise, 0, 255).astype(np.uint8)
    # 加上大块渐变与几个形状, 让它"看起来像张照片"而非纯雪花
    grad = np.linspace(0, 255, w, dtype=np.float32)
    img = np.clip(img.astype(np.float32) + grad[None, :, None] * 0.3, 0, 255)
    cv2.circle(img, (w // 2, h // 2), 90, (60, 200, 240), -1)
    cv2.rectangle(img, (60, 360), (260, 440), (200, 80, 60), -1)
    cv2.line(img, (0, 0), (w, h), (255, 255, 255), 4)
    return img.astype(np.uint8)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    panorama = build_panorama()
    cv2.imwrite(str(OUT_DIR / "00_source_panorama.png"), panorama)

    # 4 张可匹配照片: 文件名序号即演示加载顺序
    crops = [
        ("01_left.jpg",       0,                1.00, (1.00, 1.00, 1.00)),
        ("02_mid_left.jpg",   CROP_STEP,        0.68, (1.05, 1.00, 0.92)),  # 偏暗
        # 03 留给无法匹配的噪声图, 制造断链
        ("04_mid_right.jpg",  CROP_STEP * 2,    1.28, (0.92, 1.00, 1.08)),  # 偏亮偏暖
        ("05_right.jpg",      CROP_STEP * 3,    0.90, (0.96, 1.03, 1.00)),
    ]
    for name, x0, gain, tint in crops:
        photo = crop_photo(panorama, x0)
        photo = apply_exposure(photo, gain, tint)
        cv2.imwrite(str(OUT_DIR / name), photo, [cv2.IMWRITE_JPEG_QUALITY, 92])

    cv2.imwrite(
        str(OUT_DIR / "03_unmatched.jpg"), make_unmatched(),
        [cv2.IMWRITE_JPEG_QUALITY, 92],
    )

    print(f"演示素材已生成到 {OUT_DIR}")
    for p in sorted(OUT_DIR.iterdir()):
        print(" -", p.name)
    print(
        "\n预期: 01-02 可对齐, 02->03 与 03->04 匹配失败(断成两组), "
        "04-05 可对齐; 02 偏暗、04 偏亮, 用于验证曝光融合。"
    )


if __name__ == "__main__":
    main()
