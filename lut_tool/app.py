"""Tkinter 图形界面：原片 / 套表 / 差值三联同步检查。

布局
----
* 顶部：两张表的加载区、顺序切换、槽位 A/B 配置存取；
* 中部：三个画面共享同一帧索引（滑块/播放/步进完全同步），可叠加
  范围外与钳位标记；
* 右侧：探针列表，逐点显示入表/出表数值与越界状态；
* 底部：测试片生成、短片导出与编码往返检查、分析结果。

GUI 仅负责交互与显示，所有计算都在 lut_tool 的无 GUI 模块里完成。
"""

from __future__ import annotations

import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import Image, ImageTk

from . import __version__
from .analysis import analyze_clip_frame, analyze_lut_shape
from .config import (
    CompareConfig,
    ConfigStore,
    SafeLutLoader,
    load_configs,
    save_configs,
)
from .cube import CubeParseError, parse_cube
from .lut import (
    CLIP_MARKER,
    OOR_MARKER,
    apply_chain,
    diff_heatmap,
    diff_stats,
)
from .patterns import TestClipSpec, render_clip, render_frame
from .video import (
    CODEC_PRESETS,
    VideoReader,
    export_and_verify,
    quantize_8bit,
    rgb_float_to_bgr,
)

PREVIEW_W = 300  # 单幅预览宽度


def _rgb_to_photo(rgb: np.ndarray) -> ImageTk.PhotoImage:
    """float64 RGB -> Tk 可显示的 PhotoImage。"""
    u8 = np.rint(np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    return ImageTk.PhotoImage(Image.fromarray(u8, mode="RGB"))


class Probe:
    """一个画面探针：归一化坐标 + 所在画面。"""

    def __init__(self, name: str, x: int, y: int, panel: str = "套表"):
        self.name = name
        self.x = x
        self.y = y
        self.panel = panel


class LutInspectorApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title(f"本地视频颜色表检查工具 v{__version__}")
        root.geometry("1180x760")

        # ---- 状态 ------------------------------------------------------
        self.spec = TestClipSpec()
        self.clip = render_clip(self.spec)  # 测试片 float64 RGB
        self.external_reader: VideoReader | None = None
        self.external_frames: np.ndarray | None = None
        self.frame_count = self.clip.shape[0]
        self.current_index = 0

        self.loader_a = SafeLutLoader()
        self.loader_b = SafeLutLoader()
        self.swapped = tk.BooleanVar(value=False)
        self.show_oor = tk.BooleanVar(value=True)
        self.show_clip = tk.BooleanVar(value=False)
        self.playing = False
        self._play_job: str | None = None
        self._photos: list[ImageTk.PhotoImage] = []

        self.probes: list[Probe] = [
            Probe("探针1", self.spec.width // 4, self.spec.height // 2),
            Probe("探针2", self.spec.width // 2, self.spec.height // 4),
            Probe("探针3", self.spec.width * 3 // 4, self.spec.height * 3 // 4),
        ]

        self.store = ConfigStore.empty()
        self._build_ui()
        self._refresh_all()

    # ================================================================ UI
    def _build_ui(self) -> None:
        top = ttk.Frame(self.root, padding=6)
        top.pack(fill=tk.X)

        # ---- 表 A ------------------------------------------------------
        box_a = ttk.LabelFrame(top, text="表 A（第一级）", padding=4)
        box_a.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)
        self.lbl_a = ttk.Label(box_a, text="（未加载，当前为直通）", foreground="#666")
        self.lbl_a.pack(anchor=tk.W)
        row = ttk.Frame(box_a)
        row.pack(fill=tk.X, pady=2)
        ttk.Button(row, text="加载 .cube…", command=lambda: self._load_lut("A")).pack(side=tk.LEFT)
        ttk.Button(row, text="清除", command=lambda: self._clear_lut("A")).pack(side=tk.LEFT, padx=4)
        self.err_a = ttk.Label(box_a, text="", foreground="#c0392b", wraplength=340)
        self.err_a.pack(anchor=tk.W)

        # ---- 表 B ------------------------------------------------------
        box_b = ttk.LabelFrame(top, text="表 B（第二级）", padding=4)
        box_b.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)
        self.lbl_b = ttk.Label(box_b, text="（未加载，当前为直通）", foreground="#666")
        self.lbl_b.pack(anchor=tk.W)
        row = ttk.Frame(box_b)
        row.pack(fill=tk.X, pady=2)
        ttk.Button(row, text="加载 .cube…", command=lambda: self._load_lut("B")).pack(side=tk.LEFT)
        ttk.Button(row, text="清除", command=lambda: self._clear_lut("B")).pack(side=tk.LEFT, padx=4)
        self.err_b = ttk.Label(box_b, text="", foreground="#c0392b", wraplength=340)
        self.err_b.pack(anchor=tk.W)

        # ---- 顺序与配置槽 ---------------------------------------------
        box_c = ttk.LabelFrame(top, text="顺序 / 配置", padding=4)
        box_c.pack(side=tk.LEFT, fill=tk.X, padx=3)
        ttk.Checkbutton(
            box_c, text="交换应用顺序 (B→A)", variable=self.swapped,
            command=self._refresh_all,
        ).pack(anchor=tk.W)
        ttk.Checkbutton(
            box_c, text="标记超出适用范围像素(品红)", variable=self.show_oor,
            command=self._refresh_all,
        ).pack(anchor=tk.W)
        ttk.Checkbutton(
            box_c, text="标记输出钳位像素(橙)", variable=self.show_clip,
            command=self._refresh_all,
        ).pack(anchor=tk.W)
        slot_row = ttk.Frame(box_c)
        slot_row.pack(fill=tk.X, pady=2)
        ttk.Button(slot_row, text="存入槽A", command=lambda: self._save_slot("A")).pack(side=tk.LEFT)
        ttk.Button(slot_row, text="读取槽A", command=lambda: self._load_slot("A")).pack(side=tk.LEFT, padx=2)
        ttk.Button(slot_row, text="存入槽B", command=lambda: self._save_slot("B")).pack(side=tk.LEFT)
        ttk.Button(slot_row, text="读取槽B", command=lambda: self._load_slot("B")).pack(side=tk.LEFT, padx=2)

        # ---- 三联画面 --------------------------------------------------
        mid = ttk.Frame(self.root, padding=6)
        mid.pack(fill=tk.BOTH, expand=True)
        self.panels: dict[str, ttk.Label] = {}
        self.panel_titles: dict[str, ttk.Label] = {}
        for i, name in enumerate(("原片", "套表", "差值")):
            cell = ttk.Frame(mid)
            cell.grid(row=0, column=i, padx=6, sticky=tk.N)
            t = ttk.Label(cell, text=name, font=("Helvetica", 13, "bold"))
            t.pack()
            self.panel_titles[name] = t
            lbl = ttk.Label(cell, relief=tk.SOLID, borderwidth=1)
            lbl.pack()
            lbl.bind("<Button-1>", lambda e, n=name: self._click_add_probe(e, n))
            self.panels[name] = lbl
        ttk.Label(
            mid, text="提示：点击任一画面可在该位置追加探针",
            foreground="#666",
        ).grid(row=1, column=0, columnspan=3)

        # ---- 探针表 ----------------------------------------------------
        probe_box = ttk.LabelFrame(mid, text="探针（入表 → 出表）", padding=4)
        probe_box.grid(row=0, column=3, padx=6, sticky=tk.NS)
        cols = ("name", "in", "out", "status")
        self.probe_tree = ttk.Treeview(probe_box, columns=cols, show="headings", height=12)
        for c, w in zip(cols, (60, 150, 150, 90)):
            self.probe_tree.heading(c, text={"name": "探针", "in": "入表 RGB",
                                             "out": "出表 RGB", "status": "状态"}[c])
            self.probe_tree.column(c, width=w)
        self.probe_tree.pack(side=tk.LEFT, fill=tk.BOTH)
        sb = ttk.Scrollbar(probe_box, orient=tk.VERTICAL, command=self.probe_tree.yview)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.probe_tree.configure(yscrollcommand=sb.set)
        ttk.Button(probe_box, text="删除选中探针", command=self._delete_probe).pack(pady=4)

        # ---- 播放控制 --------------------------------------------------
        ctl = ttk.Frame(self.root, padding=6)
        ctl.pack(fill=tk.X)
        ttk.Button(ctl, text="⏮ 首帧", command=lambda: self._seek(0)).pack(side=tk.LEFT)
        ttk.Button(ctl, text="◀ 上一帧", command=lambda: self._step(-1)).pack(side=tk.LEFT, padx=2)
        self.btn_play = ttk.Button(ctl, text="▶ 播放", command=self._toggle_play)
        self.btn_play.pack(side=tk.LEFT)
        ttk.Button(ctl, text="下一帧 ▶", command=lambda: self._step(1)).pack(side=tk.LEFT, padx=2)
        ttk.Button(ctl, text="尾帧 ⏭", command=lambda: self._seek(self.frame_count - 1)).pack(side=tk.LEFT)

        self.scale = ttk.Scale(ctl, from_=0, to=max(self.frame_count - 1, 1),
                               orient=tk.HORIZONTAL, command=self._on_scale)
        self.scale.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=8)
        self.lbl_frame = ttk.Label(ctl, text="")
        self.lbl_frame.pack(side=tk.LEFT)

        # ---- 底部：数据源 / 导出 / 分析 -------------------------------
        bottom = ttk.LabelFrame(self.root, text="数据源 · 导出 · 分析", padding=6)
        bottom.pack(fill=tk.X, padx=6, pady=4)
        ttk.Button(bottom, text="重新生成测试片", command=self._regen_clip).pack(side=tk.LEFT)
        ttk.Button(bottom, text="载入外部视频…", command=self._open_video).pack(side=tk.LEFT, padx=4)
        ttk.Label(bottom, text="编码器:").pack(side=tk.LEFT)
        self.codec_var = tk.StringVar(value="mp4v")
        ttk.Combobox(bottom, textvariable=self.codec_var, width=6,
                     values=list(CODEC_PRESETS), state="readonly").pack(side=tk.LEFT)
        ttk.Button(bottom, text="导出短片并检查编码…", command=self._export).pack(side=tk.LEFT, padx=6)
        ttk.Button(bottom, text="表体诊断…", command=self._diagnose).pack(side=tk.LEFT)

        self.status = ttk.Label(self.root, text="", anchor=tk.W, foreground="#333",
                                relief=tk.SUNKEN)
        self.status.pack(fill=tk.X, side=tk.BOTTOM)

    # ================================================================ 数据源
    def _current_source(self) -> np.ndarray:
        """当前帧来源（外部视频优先，否则测试片）。"""
        if self.external_frames is not None:
            return self.external_frames
        return self.clip

    def _regen_clip(self) -> None:
        self._stop_play()
        self.spec = TestClipSpec()
        self.clip = render_clip(self.spec)
        self.external_frames = None
        if self.external_reader is not None:
            self.external_reader.close()
            self.external_reader = None
        self.frame_count = self.clip.shape[0]
        self.scale.configure(to=max(self.frame_count - 1, 1))
        self._seek(0)
        self._set_status("已重新生成内置测试片（灰阶/边界高饱和/平滑过渡/肤色/运动）")

    def _open_video(self) -> None:
        path = filedialog.askopenfilename(
            title="选择视频",
            filetypes=[("视频文件", "*.mp4 *.mkv *.mov *.avi"), ("所有文件", "*.*")],
        )
        if not path:
            return
        try:
            reader = VideoReader(path)
            frames = np.stack(list(reader.frames()))
        except Exception as exc:  # 打不开时保留现有画面
            messagebox.showerror("打开失败", str(exc))
            return
        self._stop_play()
        if self.external_reader is not None:
            self.external_reader.close()
        self.external_reader = reader
        self.external_frames = frames
        self.frame_count = frames.shape[0]
        self.spec = TestClipSpec(width=frames.shape[2], height=frames.shape[1],
                                 frames=self.frame_count)
        self.scale.configure(to=max(self.frame_count - 1, 1))
        self._seek(0)
        self._set_status(f"已载入外部视频: {os.path.basename(path)}（{self.frame_count} 帧）")

    # ================================================================ LUT
    def _ordered_loaders(self) -> tuple[SafeLutLoader, SafeLutLoader]:
        if self.swapped.get():
            return self.loader_b, self.loader_a
        return self.loader_a, self.loader_b

    def _load_lut(self, slot: str) -> None:
        path = filedialog.askopenfilename(
            title=f"为表 {slot} 选择 .cube 文件",
            filetypes=[("Cube LUT", "*.cube"), ("文本文件", "*.txt"), ("所有文件", "*.*")],
        )
        if not path:
            return
        loader = self.loader_a if slot == "A" else self.loader_b
        outcome = loader.load(path)
        if outcome.ok:
            self._set_status(f"表 {slot} 已加载: {outcome.lut.describe()}")
        else:
            # 失败：旧表仍在 loader.current 中，界面继续显示旧效果。
            messagebox.showwarning(
                "加载失败，已保留原先打开的表",
                outcome.error or "未知错误",
            )
            self._set_status(f"表 {slot} 加载失败，继续使用上一张有效表")
        self._refresh_lut_labels()
        self._refresh_all()

    def _clear_lut(self, slot: str) -> None:
        (self.loader_a if slot == "A" else self.loader_b).clear()
        self._refresh_lut_labels()
        self._refresh_all()

    def _refresh_lut_labels(self) -> None:
        for slot, loader, lbl, err in (
            ("A", self.loader_a, self.lbl_a, self.err_a),
            ("B", self.loader_b, self.lbl_b, self.err_b),
        ):
            if loader.current is not None:
                lbl.configure(text=loader.current.describe(), foreground="#1a7f37")
            else:
                lbl.configure(text="（未加载，当前为直通）", foreground="#666")
            err.configure(text=loader.last_error)

    # ================================================================ 渲染
    def _render_current(self):
        """计算当前帧的原片/套表/差值与掩码。"""
        src = self._current_source()[self.current_index]
        first, second = (ld.current for ld in self._ordered_loaders())
        chain = apply_chain(src, first, second)

        rendered = chain.out
        if self.show_oor.get():
            rendered = np.where(chain.oor_mask[..., None], OOR_MARKER, rendered)
        if self.show_clip.get():
            rendered = np.where(chain.clip_mask[..., None], CLIP_MARKER, rendered)

        heat = diff_heatmap(src, chain.out)
        stats = diff_stats(src, chain.out)
        return src, rendered, heat, chain, stats

    def _refresh_all(self) -> None:
        src, rendered, heat, chain, stats = self._render_current()
        self._photos = []
        for name, img in (("原片", src), ("套表", rendered), ("差值", heat)):
            photo = _rgb_to_photo(img)
            self._photos.append(photo)
            self.panels[name].configure(image=photo)

        order = "B→A" if self.swapped.get() else "A→B"
        self.panel_titles["套表"].configure(
            text=f"套表（顺序 {order}，越界 {int(chain.oor_mask.sum())}px，"
                 f"钳位 {int(chain.clip_mask.sum())}px）"
        )
        self.panel_titles["差值"].configure(
            text=f"差值（均值 {stats['mean_abs']:.4f}，最大 {stats['max_abs']:.4f}）"
        )
        self.lbl_frame.configure(
            text=f"帧 {self.current_index + 1}/{self.frame_count}"
        )
        self.scale.set(self.current_index)
        self._refresh_probes(src, chain)
        self._set_status(
            f"变化像素占比 {stats['changed_ratio'] * 100:.1f}% | "
            f"逐通道均值差 R {stats['mean_per_channel'][0]:.4f} "
            f"G {stats['mean_per_channel'][1]:.4f} B {stats['mean_per_channel'][2]:.4f}"
        )

    def _refresh_probes(self, src: np.ndarray, chain) -> None:
        for row in self.probe_tree.get_children():
            self.probe_tree.delete(row)
        h, w = src.shape[:2]
        for p in self.probes:
            if not (0 <= p.x < w and 0 <= p.y < h):
                continue
            vin = src[p.y, p.x]
            vout = chain.out[p.y, p.x]
            oor = bool(chain.oor_mask[p.y, p.x])
            clip = bool(chain.clip_mask[p.y, p.x])
            if oor and clip:
                status, color = "越界+钳位", "#c0392b"
            elif oor:
                status, color = "超出适用范围", "#c0392b"
            elif clip:
                status, color = "输出钳位", "#d35400"
            else:
                status, color = "范围内", "#1a7f37"
            self.probe_tree.insert(
                "", tk.END,
                values=(
                    p.name,
                    f"{vin[0]:.4f} {vin[1]:.4f} {vin[2]:.4f}",
                    f"{vout[0]:.4f} {vout[1]:.4f} {vout[2]:.4f}",
                    status,
                ),
                tags=(color,),
            )
        self.probe_tree.tag_configure("#c0392b", foreground="#c0392b")
        self.probe_tree.tag_configure("#d35400", foreground="#d35400")
        self.probe_tree.tag_configure("#1a7f37", foreground="#1a7f37")

    # ================================================================ 播放
    def _on_scale(self, value: str) -> None:
        idx = int(float(value))
        if idx != self.current_index:
            self.current_index = idx
            self._refresh_all()

    def _seek(self, idx: int) -> None:
        self.current_index = int(np.clip(idx, 0, self.frame_count - 1))
        self._refresh_all()

    def _step(self, delta: int) -> None:
        self._seek(self.current_index + delta)

    def _toggle_play(self) -> None:
        if self.playing:
            self._stop_play()
        else:
            self.playing = True
            self.btn_play.configure(text="⏸ 暂停")
            self._tick()

    def _stop_play(self) -> None:
        self.playing = False
        self.btn_play.configure(text="▶ 播放")
        if self._play_job is not None:
            self.root.after_cancel(self._play_job)
            self._play_job = None

    def _tick(self) -> None:
        if not self.playing:
            return
        nxt = self.current_index + 1
        if nxt >= self.frame_count:
            nxt = 0  # 循环播放
        self.current_index = nxt
        self._refresh_all()
        delay = int(1000 / max(self.spec.fps, 1))
        self._play_job = self.root.after(delay, self._tick)

    # ================================================================ 探针
    def _click_add_probe(self, event, panel: str) -> None:
        # 预览被等比缩放到 PREVIEW_W，需要换算回原图像素坐标。
        lbl = self.panels[panel]
        src = self._current_source()[self.current_index]
        h, w = src.shape[:2]
        disp_w = lbl.winfo_width() or PREVIEW_W
        disp_h = lbl.winfo_height() or int(PREVIEW_W * h / w)
        if not (0 <= event.x < disp_w and 0 <= event.y < disp_h):
            return
        x = int(event.x / disp_w * w)
        y = int(event.y / disp_h * h)
        name = f"探针{len(self.probes) + 1}"
        self.probes.append(Probe(name, x, y, panel))
        self._refresh_all()

    def _delete_probe(self) -> None:
        sel = self.probe_tree.selection()
        if not sel:
            return
        names = {self.probe_tree.item(s, "values")[0] for s in sel}
        self.probes = [p for p in self.probes if p.name not in names]
        self._refresh_all()

    # ================================================================ 配置槽
    def _current_config(self, slot: str) -> CompareConfig:
        return CompareConfig(
            name=slot,
            first_path=self.loader_a.current.path if self.loader_a.current else "",
            second_path=self.loader_b.current.path if self.loader_b.current else "",
            swapped=self.swapped.get(),
        )

    def _save_slot(self, slot: str) -> None:
        self.store.slots[slot] = self._current_config(slot)
        try:
            path = save_configs(self.store)
        except OSError as exc:
            messagebox.showerror("保存失败", str(exc))
            return
        self._set_status(f"配置已存入槽 {slot}: {path}")

    def _load_slot(self, slot: str) -> None:
        try:
            self.store = load_configs()
        except (OSError, ValueError) as exc:
            messagebox.showerror("读取配置失败", str(exc))
            return
        cfg = self.store.slots[slot]
        # 逐张安全加载：任何一张失败都不清空已打开的另一张。
        for which, loader, path in (
            ("A", self.loader_a, cfg.first_path),
            ("B", self.loader_b, cfg.second_path),
        ):
            if path and os.path.exists(path):
                outcome = loader.load(path)
                if outcome.error:
                    messagebox.showwarning(
                        f"表 {which} 加载失败，已保留原先打开的表", outcome.error
                    )
            elif path:
                messagebox.showwarning(
                    f"表 {which} 文件不存在", path
                )
        self.swapped.set(cfg.swapped)
        self._refresh_lut_labels()
        self._refresh_all()
        self._set_status(f"已读取槽 {slot} 配置")

    # ================================================================ 导出/分析
    def _export(self) -> None:
        path = filedialog.asksaveasfilename(
            title="导出套表短片",
            defaultextension=CODEC_PRESETS[self.codec_var.get()][1],
            filetypes=[("视频", "*.mp4 *.mkv")],
        )
        if not path:
            return
        source = self._current_source()
        first, second = (ld.current for ld in self._ordered_loaders())
        processed = np.stack([
            apply_chain(source[i], first, second).out
            for i in range(source.shape[0])
        ])
        try:
            actual, report = export_and_verify(
                processed, path, self.spec.fps, self.codec_var.get()
            )
        except Exception as exc:
            messagebox.showerror("导出失败", str(exc))
            return

        # 在预览里追加一帧“编码往返差异”检查：取第一个可见差异帧。
        message = (
            f"已导出: {os.path.basename(actual)}\n\n{report.summary()}\n\n"
            f"量化最大差 {report.quant_error['max_abs']:.5f}\n"
            f"编码附加最大差 {report.codec_error['max_abs']:.5f}\n"
            f"（预览与读回均采用 float64 RGB/[0,1] 同一颜色约定）"
        )
        if report.visible_frames:
            fi, peak = report.visible_frames[0]
            message += f"\n\n首个可见差异帧: 第 {fi + 1} 帧，峰值 {peak:.4f}"
        messagebox.showinfo("编码往返检查", message)
        self._set_status(report.summary())

    def _diagnose(self) -> None:
        first, second = (ld.current for ld in self._ordered_loaders())
        if first is None and second is None:
            messagebox.showinfo("表体诊断", "当前没有加载任何表")
            return
        lines = []
        for name, lut in (("第一级", first), ("第二级", second)):
            if lut is None:
                lines.append(f"[{name}] 直通")
                continue
            rep = analyze_lut_shape(lut)
            lines.append(f"[{name}] {lut.describe()}")
            if rep["monotonic_violations"]:
                lines.append(f"  单调性破坏 {len(rep['monotonic_violations'])} 处")
            else:
                lines.append("  单调性: 正常")
            if rep["spike_channels"]:
                chs = "RGB"
                lines.append(
                    "  颜色突变通道: "
                    + ", ".join(chs[r.channel] for r in rep["spike_channels"])
                )
            else:
                lines.append("  颜色突变: 未发现")
            cross = [c for c in rep["cross_reports"] if not c.clean]
            if cross:
                for c in cross:
                    if c.swapped_with is not None:
                        lines.append(
                            f"  通道串换: { 'RGB'[c.driven_channel]}"
                            f"→{'RGB'[c.swapped_with]} 疑似互换"
                        )
                    else:
                        leak = ", ".join(
                            f"{'RGB'[k]}={v:.5f}" for k, v in c.leakage.items()
                        )
                        lines.append(f"  通道串扰 ({'RGB'[c.driven_channel]}): {leak}")
            else:
                lines.append("  通道串换: 未发现")
            lines.append(
                f"  输出范围: {rep['output_min'].round(4)} ~ "
                f"{rep['output_max'].round(4)}，钳位采样占比 "
                f"{rep['output_clipped_ratio'] * 100:.2f}%"
            )
        messagebox.showinfo("表体诊断", "\n".join(lines))

    def _set_status(self, text: str) -> None:
        self.status.configure(text=text)


def main() -> None:
    root = tk.Tk()
    LutInspectorApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
