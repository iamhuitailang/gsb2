"""核心转换算法与校准数据结构。

模型(每通道独立):
  扫描值 n ∈ [0,1],片底颜色 B(未曝光片边的扫描值)。
  密度   d = -log2(n / B)     —— 单位"档",片底处 d=0,曝光越多越大
  灰块密度 dg_c 各通道不同(片基色罩),整体平移使灰块中性并落到目标亮度:
      d' = d - dg_c + d_target,  d_target = -γf·log2(1-gray_target)
  影调映射(胶片特性曲线的指数形式):
      p = 1 - 2^(-d'/γf)        —— 片底->黑, 密度越大越亮
  单张微调: 曝光平移(档)、黑/白点、附加 gamma。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

EPS = 1e-6


@dataclass
class RollCalib:
    """卷级校准: 同一卷胶片共用, 由片底和参考灰块取样得到。"""

    base_rgb: list                 # 片底(未曝光片边)扫描颜色, [0,1] x 3
    gray_rgb: list                 # 参考灰块扫描颜色
    gray_target: float = 0.18      # 灰块在正片中的目标亮度
    film_gamma: float = 1.0        # 胶片特性曲线指数(影调映射用)
    gamma: float = 1.0             # 卷级附加 gamma
    samples: dict = field(default_factory=dict)  # 取样记录(审计/复查用)

    def gray_densities(self) -> np.ndarray:
        base = np.asarray(self.base_rgb, dtype=np.float64)
        gray = np.asarray(self.gray_rgb, dtype=np.float64)
        return -np.log2(np.clip(gray / base, EPS, 1.0))

    def target_density(self) -> float:
        """灰块目标亮度对应的密度(档)。"""
        return float(-self.film_gamma * np.log2(1.0 - self.gray_target))

    def save(self, path: str | Path) -> None:
        data = asdict(self)
        data["version"] = 1
        data["target_density_stops"] = self.target_density()
        Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "RollCalib":
        data = json.loads(Path(path).read_text())
        data.pop("version", None)
        data.pop("target_density_stops", None)
        return cls(**data)


@dataclass
class FrameAdjust:
    """单张微调。全部相对于卷级校准: 卷级定基准, 这里只存增量/局部值。"""

    exposure: float = 0.0   # 曝光平移(档), + 提亮正片
    black: float = 0.0      # 暗处黑点, 正片域 [0,1)
    white: float = 1.0      # 高光白点, 正片域 (0,1]
    gamma: float = 1.0      # 单张附加 gamma(与卷级相乘)

    def effective(self, roll: RollCalib) -> dict:
        """卷级值 / 单张增量 / 生效值 三栏对照, 让两者关系一目了然。"""
        return {
            "exposure_stops": {"roll": 0.0, "frame_delta": round(self.exposure, 4),
                               "effective": round(self.exposure, 4)},
            "black":          {"roll": 0.0, "frame_delta": round(self.black, 4),
                               "effective": round(self.black, 4)},
            "white":          {"roll": 1.0, "frame_delta": round(self.white - 1.0, 4),
                               "effective": round(self.white, 4)},
            "gamma":          {"roll": roll.gamma, "frame_delta": round(self.gamma, 4),
                               "effective": round(roll.gamma * self.gamma, 4)},
            "film_gamma":     {"roll": roll.film_gamma, "frame_delta": 0.0,
                               "effective": roll.film_gamma},
        }


def convert_image(img: np.ndarray, roll: RollCalib, adj: FrameAdjust | None = None) -> np.ndarray:
    """负片扫描图 -> 正片, 输入输出均为 float RGB [0,1]。"""
    adj = adj or FrameAdjust()
    base = np.asarray(roll.base_rgb, dtype=np.float64)
    d = -np.log2(np.clip(img.astype(np.float64) / base, EPS, 1.0))
    dg = roll.gray_densities()
    d = d - dg + roll.target_density()    # 去色罩 + 灰块落到目标亮度
    d = d - adj.exposure                  # 单张曝光微调
    p = 1.0 - 2.0 ** (-np.clip(d, 0.0, None) / roll.film_gamma)
    p = (p - adj.black) / max(adj.white - adj.black, 1e-3)  # 暗处/高光
    p = np.clip(p, 0.0, 1.0)
    g = roll.gamma * adj.gamma
    if abs(g - 1.0) > 1e-9:
        p = p ** (1.0 / g)
    return p.astype(np.float32)


def save_frame_params(path: str | Path, roll: RollCalib, adj: FrameAdjust,
                      calib_path: str | None = None) -> None:
    """导出可重放的单张参数: 卷级校准(内嵌+引用) + 单张增量 + 生效值。"""
    data = {
        "version": 1,
        "calib_ref": calib_path,
        "roll": asdict(roll),
        "frame": asdict(adj),
        "effective": adj.effective(roll),
    }
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2))


def load_frame_params(path: str | Path) -> tuple[RollCalib, FrameAdjust]:
    data = json.loads(Path(path).read_text())
    roll_data = dict(data["roll"])
    roll_data.pop("target_density_stops", None)
    return RollCalib(**roll_data), FrameAdjust(**data["frame"])
