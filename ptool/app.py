"""交互式周期纹理抑制 GUI(matplotlib)。

布局:  原图(可框选) | 频谱(点击选峰) | 结果(与原图同步缩放)
操作:
  - 打开程序后自动检测可疑峰,频谱上红圈标出,旁边标注方向/间距
  - 点击频谱:切换最近的候选峰(自动连带共轭);右键:精确添加该点
  - 在原图上拖拽框选参考区域,点「参考区估计」从该区域提取干扰峰
  - 「应用整图」/「应用局部」(局部=当前框选区域,边缘余弦渐变无硬框)
  - 滑杆调节陷波半径/深度,实时重算
  - 「导出」保存结果 PNG + 设置 JSON
"""
from __future__ import annotations

import json
import os

import numpy as np
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.widgets import Button, RectangleSelector, Slider

# macOS 中文字体,避免标签显示为方框
matplotlib.rcParams["font.family"] = ["PingFang SC", "Hiragino Sans GB",
                                      "Arial Unicode MS", "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False

from . import core, metrics


class SuppressorApp:
    def __init__(self, img, title="periodic texture suppressor", clean=None, grid_mask=None):
        self.img = core.to_float(img)          # 输入图(灰度 H,W 或彩色 H,W,3)
        self.clean = clean                     # 合成场景的原图(可选,用于定量验证)
        self.grid_mask = grid_mask
        self.result = self.img.copy()
        self.candidates: list[dict] = []       # 自动检测到的候选峰
        self.selected: list[dict] = []         # 已选中的峰
        self.region = None                     # 框选区域 (y0,x0,y1,x1)

        self.fig = plt.figure(figsize=(15, 7.5))
        self.fig.canvas.manager.set_window_title(title)
        gs = self.fig.add_gridspec(2, 3, height_ratios=[1, 0.16],
                                   left=0.04, right=0.98, top=0.93, bottom=0.06)
        self.ax_img = self.fig.add_subplot(gs[0, 0])
        self.ax_spec = self.fig.add_subplot(gs[0, 1])
        self.ax_out = self.fig.add_subplot(gs[0, 2], sharex=self.ax_img, sharey=self.ax_img)

        self.ax_img.set_title("原图(拖拽框选参考/局部区域)")
        self.ax_spec.set_title("频谱(左键选峰 / 右键精确添加)")
        self.ax_out.set_title("结果(与原图同步缩放)")
        self.ax_img.imshow(self.img, cmap="gray", vmin=0, vmax=1)
        self.ax_out.imshow(self.result, cmap="gray", vmin=0, vmax=1)

        # 频谱显示(灰度图直接算;彩色图取亮度)
        gray = self.img if self.img.ndim == 2 else self.img.mean(axis=2)
        self.spec_img = core.log_magnitude(gray)
        self.ax_spec.imshow(self.spec_img, cmap="viridis", origin="upper")
        self.peak_scatter = None
        self.peak_texts = []

        # 框选
        self.rect = RectangleSelector(self.ax_img, self._on_select, useblit=True,
                                      button=[1], minspanx=8, minspany=8,
                                      spancoords="data", interactive=True)

        # 控件行
        ax_detect = self.fig.add_subplot(gs[1, 0])
        ax_detect.axis("off")
        self.info = ax_detect.text(0, 0.95, "", va="top", fontsize=8)

        ax_ctrl = self.fig.add_subplot(gs[1, 1:])
        ax_ctrl.axis("off")
        cax = ax_ctrl.inset_axes([0.0, 0.55, 0.30, 0.35]);  self.s_radius = Slider(cax, "陷波半径", 0.002, 0.03, valinit=0.008, valfmt="%.4f")
        cax = ax_ctrl.inset_axes([0.36, 0.55, 0.30, 0.35]);  self.s_depth = Slider(cax, "压制深度", 0.1, 1.0, valinit=1.0, valfmt="%.2f")
        self.s_radius.on_changed(lambda _: self._refresh())
        self.s_depth.on_changed(lambda _: self._refresh())

        labels = ["检测峰值", "参考区估计", "应用整图", "应用局部", "重置", "导出"]
        self.buttons = {}
        for i, lab in enumerate(labels):
            bax = ax_ctrl.inset_axes([0.02 + i * 0.16, 0.05, 0.14, 0.32])
            b = Button(bax, lab)
            b.on_clicked(getattr(self, f"_cmd_{i}"))
            self.buttons[lab] = b

        self.fig.canvas.mpl_connect("button_press_event", self._on_spec_click)
        self._cmd_0(None)  # 初始自动检测
        self._refresh()

    # ------------------------------------------------------------ 交互回调

    def _on_select(self, eclick, erelease):
        y0, y1 = sorted([eclick.ydata, erelease.ydata])
        x0, x1 = sorted([eclick.xdata, erelease.xdata])
        self.region = (int(y0), int(x0), int(y1), int(x1))
        self._set_info(f"已框选区域 y[{y0}:{y1}] x[{x0}:{x1}]")

    def _on_spec_click(self, ev):
        if ev.inaxes is not self.ax_spec or ev.xdata is None:
            return
        h, w = self.spec_img.shape
        cy, cx = h / 2, w / 2
        fy, fx = (ev.ydata - cy) / h, (ev.xdata - cx) / w
        if ev.button == 3:  # 右键:精确添加该频率点
            self._toggle_peak(dict(fy=fy, fx=fx, angle_deg=np.degrees(np.arctan2(fy, fx)),
                                   period_px=1 / max(np.hypot(fy, fx), 1e-9), mag=0.0))
            return
        # 左键:切换最近的候选峰
        if not self.candidates:
            return
        d = [np.hypot(p["fy"] - fy, p["fx"] - fx) for p in self.candidates]
        i = int(np.argmin(d))
        if d[i] < 0.03:
            self._toggle_peak(self.candidates[i])

    def _toggle_peak(self, peak):
        key = lambda p: (round(p["fy"], 5), round(p["fx"], 5))
        k = key(peak)
        if any(key(p) == k for p in self.selected):
            self.selected = [p for p in self.selected if key(p) != k]
        else:
            self.selected.append(peak)
        self._draw_peaks()
        self._refresh()

    # ------------------------------------------------------------ 按钮命令

    def _cmd_0(self, _):  # 检测峰值
        gray = self.img if self.img.ndim == 2 else self.img.mean(axis=2)
        self.candidates = core.detect_peaks(gray, n_peaks=16)
        self._draw_peaks()
        self._set_info("检测到 %d 个可疑峰,点击频谱选择要压制的峰" % len(self.candidates))

    def _cmd_1(self, _):  # 参考区估计
        if self.region is None:
            self._set_info("请先在原图上拖拽框选一个参考区域")
            return
        peaks = core.estimate_peaks_from_region(self.img, self.region)
        self.candidates = peaks
        self.selected = list(peaks)
        self._draw_peaks()
        self._set_info(f"从参考区估计到 {len(peaks)} 个干扰峰,已自动选中")
        self._refresh()

    def _cmd_2(self, _):  # 应用整图
        self._apply(region=None)

    def _cmd_3(self, _):  # 应用局部
        if self.region is None:
            self._set_info("请先在原图上框选要局部处理的区域")
            return
        self._apply(region=self.region)

    def _cmd_4(self, _):  # 重置
        self.result = self.img.copy()
        self.selected = []
        self._draw_peaks()
        self._refresh()

    def _cmd_5(self, _):  # 导出
        os.makedirs("output", exist_ok=True)
        png = os.path.join("output", "result.png")
        cfg = os.path.join("output", "settings.json")
        plt.imsave(png, np.clip(self.result, 0, 1),
                   cmap="gray" if self.result.ndim == 2 else None)
        settings = dict(
            peaks=[{k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
                    for k, v in p.items()} for p in self.selected],
            radius_frac=float(self.s_radius.val),
            depth=float(self.s_depth.val),
            region=self.region,
            image_shape=list(self.img.shape),
        )
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        self._set_info(f"已导出 {png} 和 {cfg}")

    # ------------------------------------------------------------ 内部

    def _apply(self, region):
        if not self.selected:
            self._set_info("尚未选择任何峰")
            return
        self.result = core.suppress(self.img, self.selected,
                                    radius_frac=self.s_radius.val,
                                    depth=self.s_depth.val,
                                    region=region)
        self._refresh(metrics_note=True)

    def _refresh(self, metrics_note=False):
        self.ax_out.clear()
        self.ax_out.imshow(np.clip(self.result, 0, 1), cmap="gray", vmin=0, vmax=1)
        self.ax_out.set_title("结果(与原图同步缩放)")
        lines = [f"已选 {len(self.selected)} 个峰:"]
        for p in self.selected:
            lines.append(f"  方向 {p['angle_deg']:6.1f}°  间距 {p['period_px']:6.2f}px")
        if metrics_note and self.selected:
            s0 = metrics.periodic_strength(self.img, self.selected)
            s1 = metrics.periodic_strength(self.result, self.selected)
            lines.append(f"周期强度: {s0:.4f} → {s1:.4f}  (下降 {100*(1-s1/max(s0,1e-12)):.1f}%)")
            if self.clean is not None:
                lines.append(f"PSNR vs 原图: {metrics.psnr(self.img, self.clean):.2f} → "
                             f"{metrics.psnr(self.result, self.clean):.2f} dB")
                if self.grid_mask is not None:
                    lines.append(f"格线损失: {100*metrics.signal_loss(self.result, self.clean, self.grid_mask):.1f}%")
                if self.result.ndim == 3:
                    fr = metrics.color_fringe(self.result, self.clean)
                    lines.append(f"颜色条纹: 最大通道偏差 {fr['max_channel_dev']:.4f}")
        self._set_info("\n".join(lines))
        self.fig.canvas.draw_idle()

    def _draw_peaks(self):
        for t in self.peak_texts:
            t.remove()
        self.peak_texts = []
        if self.peak_scatter is not None:
            self.peak_scatter.remove()
            self.peak_scatter = None
        h, w = self.spec_img.shape
        cy, cx = h / 2, w / 2
        key = lambda p: (round(p["fy"], 5), round(p["fx"], 5))
        sel = {key(p) for p in self.selected}
        xs, ys, colors = [], [], []
        for i, p in enumerate(self.candidates):
            y, x = cy + p["fy"] * h, cx + p["fx"] * w
            xs.append(x); ys.append(y)
            on = key(p) in sel
            colors.append("red" if on else "white")
            t = self.ax_spec.text(x + 4, y + 4, f"{i}:{p['angle_deg']:.0f}°/{p['period_px']:.1f}px",
                                  color="red" if on else "white", fontsize=7)
            self.peak_texts.append(t)
        if xs:
            self.peak_scatter = self.ax_spec.scatter(xs, ys, s=90, facecolors="none",
                                                     edgecolors=colors, linewidths=1.5)
        self.fig.canvas.draw_idle()

    def _set_info(self, msg):
        self.info.set_text(msg)
        self.fig.canvas.draw_idle()

    def show(self):
        plt.show()


def run(img=None, clean=None, grid_mask=None, synth_variant=None):
    """img 为 None 时生成合成场景。"""
    from . import synth
    if img is None:
        color = (synth_variant == "color")
        scene = synth.synth_scene(color=color)
        img, clean, grid_mask = scene["corrupted"], scene["clean"], scene["grid_mask"]
    app = SuppressorApp(img, clean=clean, grid_mask=grid_mask)
    app.show()
