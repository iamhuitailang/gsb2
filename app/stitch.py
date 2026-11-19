"""相邻图片特征匹配与单应性估计。

全部基于 OpenCV 本地计算, 不访问网络。匹配失败时返回明确的原因,
由上层决定如何保留其它已成功的分组。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 匹配质量阈值
MIN_MATCH_COUNT = 8          # 单应性最少需要的内点数
RATIO_TEST = 0.75            # Lowe 比率测试
RANSAC_THRESHOLD = 5.0


@dataclass
class PairResult:
    """相邻一对图片 (i -> i+1) 的匹配结果。"""

    index: int                 # 对序号, 对应 order[index] 与 order[index+1]
    ok: bool
    reason: str = ""
    inliers: int = 0
    total_matches: int = 0
    # 把第 i+1 张图片坐标映射到第 i 张图片坐标系的 3x3 单应性矩阵
    homography: np.ndarray | None = None


class FeatureStore:
    """图片灰度图与 SIFT 关键点/描述子的缓存。"""

    def __init__(self) -> None:
        self._gray: dict[str, np.ndarray] = {}
        self._features: dict[str, tuple[tuple, np.ndarray | None]] = {}
        try:
            self._detector = cv2.SIFT_create()
            self._detector_name = "SIFT"
        except Exception:  # pragma: no cover - 老版本 OpenCV 回退
            self._detector = cv2.ORB_create(nfeatures=2000)
            self._detector_name = "ORB"

    @property
    def detector_name(self) -> str:
        return self._detector_name

    def gray(self, image_id: str, bgr: np.ndarray) -> np.ndarray:
        g = self._gray.get(image_id)
        if g is None:
            g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            self._gray[image_id] = g
        return g

    def features(self, image_id: str, bgr: np.ndarray):
        cached = self._features.get(image_id)
        if cached is not None:
            return cached
        gray = self.gray(image_id, bgr)
        kps, desc = self._detector.detectAndCompute(gray, None)
        self._features[image_id] = (kps, desc)
        return kps, desc

    def drop(self, image_id: str) -> None:
        self._gray.pop(image_id, None)
        self._features.pop(image_id, None)


def estimate_pair(
    index: int,
    id_a: str,
    id_b: str,
    bgr_a: np.ndarray,
    bgr_b: np.ndarray,
    store: FeatureStore,
) -> PairResult:
    """估计相邻两张图的单应性。

    返回的 H 满足: 图片 b 中的点 p_b, 映射到图片 a 坐标系为 H @ p_b。
    任何失败都会带中文原因返回, 不抛异常。
    """
    kp_a, desc_a = store.features(id_a, bgr_a)
    kp_b, desc_b = store.features(id_b, bgr_b)

    if desc_a is None or desc_b is None:
        return PairResult(index, ok=False, reason="某张图未检测到足够纹理特征")
    if len(kp_a) < MIN_MATCH_COUNT or len(kp_b) < MIN_MATCH_COUNT:
        return PairResult(
            index, ok=False,
            reason=f"特征点不足({len(kp_a)}/{len(kp_b)}, 至少需要 {MIN_MATCH_COUNT})",
        )

    norm = (
        cv2.NORM_L2 if store.detector_name == "SIFT" else cv2.NORM_HAMMING
    )
    matcher = cv2.BFMatcher(norm)
    raw = matcher.knnMatch(desc_b, desc_a, k=2)
    good = [
        m for m_pair in raw
        if len(m_pair) == 2
        for m in [m_pair[0]]
        if m.distance < RATIO_TEST * m_pair[1].distance
    ]
    if len(good) < MIN_MATCH_COUNT:
        return PairResult(
            index, ok=False, total_matches=len(good),
            reason=(
                f"可靠匹配仅 {len(good)} 对(少于 {MIN_MATCH_COUNT}), "
                "两张图可能没有重叠区域"
            ),
        )

    src = np.float32([kp_b[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_a[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    h_mat, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC_THRESHOLD)
    if h_mat is None or mask is None:
        return PairResult(
            index, ok=False, total_matches=len(good),
            reason="RANSAC 无法估计单应性矩阵(匹配点几何关系不一致)",
        )

    inliers = int(mask.sum())
    if inliers < MIN_MATCH_COUNT:
        return PairResult(
            index, ok=False, total_matches=len(good), inliers=inliers,
            reason=f"几何内点仅 {inliers} 个(少于 {MIN_MATCH_COUNT}), 匹配不可靠",
        )

    return PairResult(
        index, ok=True, inliers=inliers, total_matches=len(good),
        homography=h_mat.astype(np.float64),
    )


def estimate_chain(
    order: list[str],
    images: dict[str, np.ndarray],
    store: FeatureStore,
) -> list[PairResult]:
    """按当前顺序估计所有相邻对。某一对失败不影响其它对继续计算。"""
    results: list[PairResult] = []
    for i in range(len(order) - 1):
        id_a, id_b = order[i], order[i + 1]
        if id_a not in images or id_b not in images:
            results.append(PairResult(i, ok=False, reason="图片数据缺失"))
            continue
        results.append(estimate_pair(i, id_a, id_b, images[id_a], images[id_b], store))
    return results
