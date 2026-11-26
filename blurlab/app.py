"""界面控制器：不含 Tk 的状态机，便于单元测试。

GUI 只负责把鼠标/控件事件翻译成这里的方法调用；所有估计、区域管理、预览、
扫描、导出逻辑都在这一层，测试无需显示器。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .compare import ViewState, format_sweep_table, render_triptych
from .deblur import DeblurParams
from .estimate import BlurEstimate, estimate_blur, manual_estimate
from .export import export_result, format_validation, save_validation, validate_pair
from .image_io import load_image, load_meta, write_json
from .pipeline import PipelineResult, process_regions, sweep_parameters
from .profile import Profile, edge_profile_from_segment
from .regions import Region, RegionSet, coverage_overlay
from .synth import save_sample_suite


@dataclass
class ControllerState:
    image: np.ndarray | None = None
    clean: np.ndarray | None = None
    meta: dict | None = None
    source: str | None = None
    region_set: RegionSet | None = None
    active_region: Region | None = None
    profiles: list[Profile] = field(default_factory=list)
    profile_labels: list[str] = field(default_factory=list)
    estimate: BlurEstimate | None = None
    last_pipeline: PipelineResult | None = None
    view: ViewState = field(default_factory=ViewState)
    residual_gain: float = 8.0
    sweep_rows: list[dict] = field(default_factory=list)


class AppController:
    def __init__(self) -> None:
        self.s = ControllerState()

    # ------------------------------------------------------------------ 载入
    def load_image(self, path: str | Path, clean: str | Path | None = None, meta: str | Path | None = None) -> None:
        img = load_image(path)
        self.s.image = img
        self.s.source = str(path)
        self.s.clean = load_image(clean) if clean else None
        self.s.meta = load_meta(meta) if meta else None
        h, w = img.shape[:2]
        self.s.region_set = RegionSet(width=w, height=h)
        self.s.active_region = None
        self.s.profiles.clear()
        self.s.profile_labels.clear()
        self.s.estimate = None
        self.s.last_pipeline = None
        self.s.view = ViewState()

    def generate_samples(self, outdir: str | Path, seed: int = 16317) -> dict:
        paths = save_sample_suite(outdir, seed=seed)
        self.load_image(paths["clean"], meta=paths["meta"])
        return paths

    def load_blurred_sample(self, path: str | Path) -> None:
        """载入拖影样例，并从同目录 meta.json 找出干净参考图。"""
        meta_path = Path(path).with_name("meta.json")
        meta = load_meta(meta_path) if meta_path.exists() else None
        self.load_image(path)
        clean = Path(path).with_name("board_clean.png")
        if clean.exists():
            self.s.clean = load_image(clean)
        self.s.meta = meta

    # ------------------------------------------------------------ 参考边估计
    def add_reference_edge(self, p0: tuple[float, float], p1: tuple[float, float]) -> BlurEstimate:
        if self.s.image is None:
            raise RuntimeError("先载入图像")
        prof = edge_profile_from_segment(self.s.image, p0, p1)
        self.s.profiles.append(prof)
        self.s.profile_labels.append(f"edge{len(self.s.profiles)}")
        est = estimate_blur(self.s.profiles, self.s.profile_labels)
        self.s.estimate = est
        return est

    def clear_reference_edges(self) -> None:
        self.s.profiles.clear()
        self.s.profile_labels.clear()
        self.s.estimate = None

    def detect_edges_from_meta(self) -> list[str]:
        """样例图专用：按 meta 里的边定义直接加参考边（等价于用户逐条拖）。

        返回成功加入的边 label；用于快速验证估计器而不是代替手动校核。
        """
        if self.s.image is None:
            raise RuntimeError("先载入图像")
        meta = self.s.meta or {}
        added = []
        for e in meta.get("edges", []):
            # meta 里的 p0/p1 是沿边端点；probe 才是跨边线段
            if "probe" in e:
                seg = (tuple(e["probe"][0]), tuple(e["probe"][1]))
            else:
                from blurlab.synth import EdgeDef

                edge = EdgeDef(
                    e["label"],
                    tuple(e["p0"]),
                    tuple(e["p1"]),
                    float(e["normal_deg"]),
                    tuple(e.get("center", (0.0, 0.0))),
                )
                seg = edge.probe_segment()
            prof = edge_profile_from_segment(self.s.image, seg[0], seg[1])
            self.s.profiles.append(prof)
            self.s.profile_labels.append(str(e["label"]))
            added.append(str(e["label"]))
        if self.s.profiles:
            self.s.estimate = estimate_blur(self.s.profiles, self.s.profile_labels)
        return added

    def set_manual_estimate(self, length_px: float, angle_deg: float) -> BlurEstimate:
        est = manual_estimate(length_px, angle_deg)
        self.s.estimate = est
        return est

    # ---------------------------------------------------------------- 区域
    def add_region(
        self,
        rect: tuple[float, float, float, float],
        use_estimate: bool = True,
        length_px: float | None = None,
        angle_deg: float | None = None,
        feather_px: float = 10.0,
        priority: int | None = None,
        label: str | None = None,
    ) -> Region:
        if self.s.image is None or self.s.region_set is None:
            raise RuntimeError("先载入图像")
        est = self.s.estimate
        if length_px is None:
            if est is None or est.length_px is None:
                raise ValueError("还没有长度参数：先选参考边估计，或手填 length_px")
            length_px = est.length_px
        if angle_deg is None:
            if est is None or est.angle_deg is None:
                raise ValueError("方向未确定：加第二条参考边，或手填 angle_deg")
            angle_deg = est.angle_deg

        params = DeblurParams(length_px=float(length_px), angle_deg=float(angle_deg))
        region = self.s.region_set.add(
            rect,
            params,
            label=label,
            feather_px=feather_px,
            priority=priority,
            estimate=est if use_estimate else None,
        )
        self.s.active_region = region
        return region

    def update_region_params(self, region: Region, **kwargs) -> None:
        for key in (
            "length_px",
            "angle_deg",
            "noise_gain",
            "regularization",
            "shadow_limit",
            "overshoot",
        ):
            if key in kwargs and kwargs[key] is not None:
                setattr(region.params, key, float(kwargs[key]))
        if "feather_px" in kwargs and kwargs["feather_px"] is not None:
            region.feather_px = float(kwargs["feather_px"])
        if "priority" in kwargs and kwargs["priority"] is not None:
            region.priority = int(kwargs["priority"])
        if "enabled" in kwargs and kwargs["enabled"] is not None:
            region.enabled = bool(kwargs["enabled"])

    def remove_region(self, region: Region) -> None:
        if self.s.region_set is None:
            return
        self.s.region_set.remove(region)
        if self.s.active_region is region:
            self.s.active_region = self.s.region_set.regions[-1] if self.s.region_set.regions else None

    # ---------------------------------------------------------------- 预览
    def preview(self, compute_metrics: bool = True) -> PipelineResult:
        if self.s.image is None or self.s.region_set is None:
            raise RuntimeError("先载入图像")
        meta = self.s.meta or {}
        bars = meta.get("bars") if self.s.clean is not None else None
        edges = meta.get("edges") if self.s.clean is not None else None
        unchanged = tuple(meta["no_blur_rect"]) if meta.get("no_blur_rect") else None
        result = process_regions(
            self.s.image,
            self.s.region_set,
            clean=self.s.clean,
            compute_metrics=compute_metrics,
            bars=bars,
            edges=edges,
            unchanged_rect=unchanged,
        )
        self.s.last_pipeline = result
        return result

    def preview_selected_only(self, region: Region) -> np.ndarray:
        """只处理一个选区，返回该区域（含余量）的预览块，用于边沿附近细看。"""
        if self.s.image is None:
            raise RuntimeError("先载入图像")
        from .deblur import deblur_image_region, suggested_padding

        x0, y0, x1, y1 = region.rect
        m = suggested_padding(region.params.length_px)
        h, w = self.s.image.shape[:2]
        bx0, by0 = max(0, x0 - m), max(0, y0 - m)
        bx1, by1 = min(w, x1 + m), min(h, y1 + m)
        out, _ = deblur_image_region(self.s.image[by0:by1, bx0:bx1], region.params)
        return out

    def coverage_image(self, mode: str = "owner") -> np.ndarray:
        if self.s.image is None or self.s.region_set is None:
            raise RuntimeError("先载入图像")
        return coverage_overlay(self.s.image, self.s.region_set, mode=mode)

    def triptych(self, pane_size: tuple[int, int] = (420, 300), rect=None):
        if self.s.image is None:
            raise RuntimeError("先载入图像")
        if self.s.last_pipeline is None:
            self.preview()
        p = self.s.last_pipeline
        return render_triptych(
            p.original,
            p.result,
            p.residual,
            view=self.s.view,
            pane_size=pane_size,
            rect=rect,
            residual_gain=self.s.residual_gain,
        )

    # ---------------------------------------------------------------- 扫描
    def sweep(self, region: Region, lengths: list[float], noise_gains: list[float] | None = None) -> list[dict]:
        if self.s.image is None:
            raise RuntimeError("先载入图像")
        rows = sweep_parameters(
            self.s.image,
            region.rect,
            region.params.angle_deg,
            lengths,
            noise_gains=noise_gains or [region.params.noise_gain],
            clean=self.s.clean,
        )
        self.s.sweep_rows = rows
        return rows

    def sweep_text(self) -> str:
        return format_sweep_table(self.s.sweep_rows)

    # ---------------------------------------------------------------- 导出
    def export(self, outdir: str | Path) -> dict:
        if self.s.image is None or self.s.region_set is None:
            raise RuntimeError("先载入图像")
        if self.s.last_pipeline is None:
            self.preview()
        p = self.s.last_pipeline
        assert p is not None
        paths = export_result(
            outdir,
            p.original,
            p.result,
            p.residual,
            self.s.region_set,
            pipeline=p,
            meta=self.s.meta,
            source=self.s.source,
        )
        self.save_estimate(Path(outdir) / "estimate.json")
        return paths

    def save_estimate(self, path: str | Path) -> None:
        payload = {
            "estimate": self.s.estimate.to_dict() if self.s.estimate else None,
            "reference_edges": [
                {
                    "label": label,
                    "normal_deg": float(prof.normal_deg),
                    "center": [float(prof.center[0]), float(prof.center[1])],
                    "window_half_px": float(prof.window_half),
                    "n_lines": int(prof.n_lines),
                }
                for label, prof in zip(self.s.profile_labels, self.s.profiles)
            ],
            "regions": [r.to_dict() for r in self.s.region_set.ordered()] if self.s.region_set else [],
            "overlaps": self.s.region_set.overlap_report() if self.s.region_set else [],
        }
        write_json(path, payload)

    # ---------------------------------------------------------------- 验证
    def validate(self, out: str | Path | None = None) -> str:
        if self.s.image is None or self.s.region_set is None:
            raise RuntimeError("先载入图像")
        if self.s.clean is None:
            raise RuntimeError("没有干净参考图，无法做配对验证")
        if self.s.last_pipeline is None:
            self.preview()
        report = validate_pair(self.s.clean, self.s.image, self.s.last_pipeline.result, self.s.meta)
        if out:
            save_validation(out, report)
        return format_validation(report)

    # ---------------------------------------------------------------- 视图
    def zoom(self, factor: float, sx: float, sy: float) -> None:
        self.s.view.zoom_at(factor, sx, sy)

    def pan(self, dx: float, dy: float) -> None:
        self.s.view.pan_by(dx, dy)

    def fit_view(self, view_w: int, view_h: int) -> None:
        """按主画布尺寸把图像适配进窗口；三格视图共享同一 scale。"""
        if self.s.image is None:
            return
        h, w = self.s.image.shape[:2]
        self.s.view.fit(w, h, max(50, int(view_w)), max(50, int(view_h)))
