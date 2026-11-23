"""应用状态：加载图像、后台跑管线、pin 增量编辑、工程保存。

GUI 各页只读写 AppState；耗时计算放后台线程，完成后通过 Tk 事件回到主线程刷新。
"""
from __future__ import annotations

import os
import queue
import threading
import tkinter as tk
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .pipeline import (
    PipelineResult,
    load_images,
    refusion_only,
    run_pipeline,
)
from .project import load_project, save_outputs, save_project
from .registration import RegistrationConfig
from .selection import Pin, PinSet, SelectionConfig
from .sharpness import SharpnessConfig

DONE_EVENT = "<<PipelineDone>>"
ERROR_EVENT = "<<PipelineError>>"


@dataclass
class AppSettings:
    temperature: float = 8.0
    fusion_mode: str = "soft"          # soft | hard
    coverage_mode: str = "keep"        # keep | crop
    show_ghost: bool = True
    reg_cfg: RegistrationConfig = field(default_factory=RegistrationConfig)
    sharp_cfg: SharpnessConfig = field(default_factory=SharpnessConfig)
    sel_cfg: SelectionConfig = field(default_factory=SelectionConfig)


class AppState:
    def __init__(self, root: tk.Misc):
        self.root = root
        self.source_paths: list[str] = []
        self.images: list[np.ndarray] = []
        self.result: PipelineResult | None = None
        self.pins = PinSet()
        self.settings = AppSettings()
        self.project_dir: str | None = None
        self._queue: queue.Queue = queue.Queue()
        self._worker: threading.Thread | None = None
        self._sticky_reg = None         # 重开工程时复用的配准
        # 若 Tk 虚拟事件不可用（无 mainloop 的嵌入场景），poll() 仍可工作
        try:
            root.bind(DONE_EVENT, lambda _e: self._drain())
            root.bind(ERROR_EVENT, lambda _e: self._drain())
        except tk.TclError:
            pass

    # ------------------------------------------------------------------ #
    # 加载
    # ------------------------------------------------------------------ #
    def load_paths(self, paths: list[str]) -> None:
        if not 3 <= len(paths) <= 5:
            raise ValueError("请选择 3~5 张同一场景的图片")
        imgs = load_images(paths)
        shape = imgs[0].shape[:2]
        for i, im in enumerate(imgs[1:], 1):
            if im.shape[:2] != shape:
                raise ValueError(f"第 {i + 1} 张尺寸 {im.shape[:2]} 与首张 {shape} 不一致")
        # 原图按用户给定顺序保留
        self.source_paths = list(paths)
        self.images = imgs
        self.pins = PinSet()
        self.result = None
        self._sticky_reg = None
        self.project_dir = None

    def load_sample_dir(self, paths: list[str]) -> None:
        self.load_paths(paths)

    def open_project(self, path: str) -> None:
        data = load_project(path)
        self.images = load_images(data["source_paths"])
        self.source_paths = data["source_paths"]
        self.pins = data["pins"]
        self.settings.temperature = data["temperature"]
        self.settings.fusion_mode = data["fusion_mode"]
        self.settings.coverage_mode = data["coverage_mode"]
        self._sticky_reg = data["registration"]
        self.project_dir = data["root"]
        self.result = None

    # ------------------------------------------------------------------ #
    # 后台管线
    # ------------------------------------------------------------------ #
    def run(self, on_done=None, on_error=None) -> None:
        if not self.images:
            return
        self._on_done = on_done
        self._on_error = on_error
        self._worker = threading.Thread(target=self._run_worker, daemon=True)
        self._worker.start()

    def _run_worker(self):
        try:
            result = run_pipeline(
                self.images, pins=self.pins,
                reg_cfg=self.settings.reg_cfg,
                sharp_cfg=self.settings.sharp_cfg,
                sel_cfg=self.settings.sel_cfg,
                temperature=self.settings.temperature,
                fusion_mode=self.settings.fusion_mode,
                coverage_mode=self.settings.coverage_mode,
                existing_reg=self._sticky_reg)
            self._queue.put(("done", result))
        except Exception as exc:  # noqa: BLE001 - 回传界面展示
            self._queue.put(("error", exc))
        # 主循环在运行时用事件唤醒；若主线程在手动轮询（无 mainloop），
        # poll() 会直接取队列，event_generate 失败可忽略
        try:
            self.root.event_generate(DONE_EVENT, when="tail")
        except RuntimeError:
            pass

    def poll(self) -> bool:
        """手动排空后台队列（无 mainloop 的场景使用）。返回是否处理了消息。"""
        if self._queue.empty():
            return False
        self._drain()
        return True

    def _drain(self):
        try:
            kind, payload = self._queue.get_nowait()
        except queue.Empty:
            return
        if kind == "done":
            self.result = payload
            # 结果复用同一个 PinSet 实例（管线已持有 self.pins），
            # 这里仅做防御性同步
            if payload.pins is not self.pins:
                self.pins = payload.pins
            cb = getattr(self, "_on_done", None)
            if cb:
                cb(payload)
        else:
            cb = getattr(self, "_on_error", None)
            if cb:
                cb(payload)

    @property
    def busy(self) -> bool:
        return self._worker is not None and self._worker.is_alive()

    # ------------------------------------------------------------------ #
    # 重融合（只改选择，不动配准；已有 pin 保留）
    # ------------------------------------------------------------------ #
    def refusion(self) -> PipelineResult:
        if self.result is None:
            raise RuntimeError("请先运行合成")
        refusion_only(self.result,
                      temperature=self.settings.temperature,
                      fusion_mode=self.settings.fusion_mode,
                      coverage_mode=self.settings.coverage_mode,
                      sel_cfg=self.settings.sel_cfg)
        return self.result
    # ------------------------------------------------------------------ #
    # pin 增量编辑
    # ------------------------------------------------------------------ #
    def add_pin(self, source_index: int, shape: str, coords: list,
                name: str = "") -> Pin:
        pin = Pin.create(source_index, shape, coords, name)
        self.pins.add(pin)
        return pin

    def remove_pin(self, pin_id: str) -> bool:
        return self.pins.remove(pin_id)

    def set_pin_source(self, pin_id: str, source_index: int) -> None:
        self.pins.update_source(pin_id, source_index)

    # ------------------------------------------------------------------ #
    # 保存
    # ------------------------------------------------------------------ #
    def save_project(self, root: str) -> str:
        if self.result is None:
            raise RuntimeError("没有可保存的合成结果")
        cache = {
            "scores": self.result.scores,
            "labels": self.result.labels,
            "weights": self.result.weights,
            "valid_mask": self.result.valid_mask,
        }
        path = save_project(
            root, self.source_paths, self.result.registration, self.pins,
            self.settings.sharp_cfg, self.settings.sel_cfg,
            self.settings.temperature, self.settings.fusion_mode,
            self.settings.coverage_mode, cache)
        save_outputs(root, self.result.fusion.composite,
                     self.result.fusion.source_map)
        self.project_dir = root
        return str(path)

    def export_composite(self, path: str) -> str:
        from .project import export_png
        return str(export_png(path, self.result.fusion.composite))

    def export_source_map(self, path: str) -> str:
        from .project import export_png
        return str(export_png(path, self.result.fusion.source_map))
