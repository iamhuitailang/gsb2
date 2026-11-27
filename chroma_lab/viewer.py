"""交互式查看器: 点击输出像素, 看它引用了哪些色度样本和对应亮度。

布局 (2 行 x 4 列):
  上排: 原图+压缩端取样网格 | Cr 阵列 | Cb 阵列 | 亮度 Y
  下排: 还原图+还原端取样网格 | 错位误差图 | 颜色损失误差图 | 点击信息

快捷键:
  d  切换压缩端取样约定 (center -> left -> topleft)
  u  切换还原端取样约定 (故意选不同的就能看到错半格)
  m  切换 双线性/最近邻 插值
  g  开关取样网格叠加
  r  重置缩放
  h  打印帮助
"""
from __future__ import annotations

import numpy as np
import matplotlib.pyplot as plt

from . import core, plotting

plotting.setup_cjk_font()


class Viewer:
    def __init__(self, rgb: np.ndarray, down_siting: str = "left",
                 up_siting: str = "center", method: str = "bilinear"):
        self.rgb = rgb
        self.h, self.w = rgb.shape[:2]
        self.cw, self.ch = core.chroma_size(self.w, self.h)
        self.down_siting = down_siting
        self.up_siting = up_siting
        self.method = method
        self.show_grid = True
        self._markers: list = []

        self.fig, axes = plt.subplots(2, 4, figsize=(17, 8.5),
                                      num="chroma_lab 查看器")
        (self.ax_orig, self.ax_cr, self.ax_cb, self.ax_y) = axes[0]
        (self.ax_recon, self.ax_mis, self.ax_loss, self.ax_info) = axes[1]
        self.ax_info.axis("off")
        self.fig.canvas.mpl_connect("button_press_event", self._on_click)
        self.fig.canvas.mpl_connect("key_press_event", self._on_key)
        self._print_help()
        self.recompute()
        plt.show()

    # ------------------------------------------------------------ 绘制

    def recompute(self):
        res = core.pipeline(self.rgb, self.down_siting, self.up_siting,
                            self.method)
        self.res = res
        self._clear_markers()

        # 保留用户当前缩放
        saved = {ax: (ax.get_xlim(), ax.get_ylim())
                 for ax in (self.ax_orig, self.ax_recon)}
        for ax in (self.ax_orig, self.ax_cr, self.ax_cb, self.ax_y,
                   self.ax_recon, self.ax_mis, self.ax_loss):
            ax.clear()

        title = (f"压缩={self.down_siting}  还原={self.up_siting}  "
                 f"插值={self.method}  |  {self.w}x{self.h} "
                 f"-> 色度 {self.cw}x{self.ch}")
        self.fig.suptitle(title)

        self.ax_orig.imshow(self.rgb / 255, interpolation="nearest")
        self.ax_orig.set_title("原图 + 压缩端取样点")
        if self.show_grid:
            self._draw_grid(self.ax_orig, self.down_siting, "cyan")

        extent = self._chroma_extent(self.down_siting)
        self.ax_cr.imshow(res["Cr"], cmap="RdBu_r", vmin=0, vmax=255,
                          interpolation="nearest", extent=extent)
        self.ax_cr.set_title(f"Cr 阵列 {self.cw}x{self.ch}\n(坐标=亮度像素)")
        self.ax_cb.imshow(res["Cb"], cmap="RdBu_r", vmin=0, vmax=255,
                          interpolation="nearest", extent=extent)
        self.ax_cb.set_title(f"Cb 阵列 {self.cw}x{self.ch}")

        self.ax_y.imshow(res["Y"], cmap="gray", vmin=0, vmax=255,
                         interpolation="nearest")
        self.ax_y.set_title("亮度 Y (全分辨率)")

        self.ax_recon.imshow(res["recon"] / 255, interpolation="nearest")
        self.ax_recon.set_title("还原图 + 还原端取样点")
        if self.show_grid:
            self._draw_grid(self.ax_recon, self.up_siting, "lime")

        mis = np.abs(res["recon"] - res["recon_matched"]).max(axis=-1)
        self.ax_mis.imshow(mis, cmap="hot", vmin=0, vmax=64,
                           interpolation="nearest")
        self.ax_mis.set_title("错位误差\n(一致约定作参考, 纯位置差)")
        loss = np.abs(res["recon_matched"] - self.rgb).max(axis=-1)
        self.ax_loss.imshow(loss, cmap="hot", vmin=0, vmax=64,
                            interpolation="nearest")
        self.ax_loss.set_title("颜色损失\n(约定一致也无法避免)")

        for ax, (xl, yl) in saved.items():
            if ax.get_images():  # 只在曾经显示过内容时恢复缩放
                ax.set_xlim(xl)
                ax.set_ylim(yl)
        self.fig.canvas.draw_idle()

    def _chroma_extent(self, siting: str):
        """让色度阵列按亮度坐标显示: 样本 i 占 [2i+dx-1, 2i+dx+1]。"""
        dx, dy = core.SITINGS[siting]
        return (dx - 1, 2 * (self.cw - 1) + dx + 1,
                2 * (self.ch - 1) + dy + 1, dy - 1)

    def _draw_grid(self, ax, siting: str, color: str):
        dx, dy = core.SITINGS[siting]
        xs, ys = core.sample_positions(self.cw, self.ch, siting)
        if self.w <= 200 and self.h <= 200:
            gx, gy = np.meshgrid(xs, ys)
            ax.scatter(gx.ravel(), gy.ravel(), s=8, c=color, marker=".",
                       linewidths=0)
            for xb in np.arange(-0.5, self.w, 2):
                ax.axvline(xb, color=color, alpha=0.15, lw=0.5)
            for yb in np.arange(-0.5, self.h, 2):
                ax.axhline(yb, color=color, alpha=0.15, lw=0.5)
        ax.set_xlim(-0.5, self.w - 0.5)
        ax.set_ylim(self.h - 0.5, -0.5)

    # ------------------------------------------------------------ 点击检查

    def _on_click(self, ev):
        if ev.inaxes not in (self.ax_orig, self.ax_recon, self.ax_y):
            return
        if ev.xdata is None or ev.ydata is None:
            return
        x = int(np.clip(round(ev.xdata), 0, self.w - 1))
        y = int(np.clip(round(ev.ydata), 0, self.h - 1))
        self.inspect(x, y)

    def inspect(self, x: int, y: int):
        self._clear_markers()
        res = self.res
        sources = core.pixel_sources(x, y, self.up_siting,
                                     self.cw, self.ch, self.method)
        dx, dy = core.SITINGS[self.up_siting]

        # 在三个视图上标出被点击像素
        for ax in (self.ax_orig, self.ax_recon, self.ax_y):
            self._markers += ax.plot(x, y, "x", color="yellow", ms=10,
                                     mew=2)
        # 在 Cr/Cb 阵列上圈出被引用的样本并标注权重
        for ci, cj, wgt in sources:
            px, py = 2 * ci + dx, 2 * cj + dy
            for ax in (self.ax_cr, self.ax_cb):
                c = plt.Circle((px, py), 1.0, fill=False, color="yellow",
                               lw=1.5)
                ax.add_patch(c)
                self._markers.append(c)
                t = ax.text(px, py - 1.6, f"{wgt:.2f}", color="yellow",
                            ha="center", fontsize=8)
                self._markers.append(t)

        y_val = res["Y"][y, x]
        cb_up, cr_up = res["Cb_up"][y, x], res["Cr_up"][y, x]
        rgb_out = res["recon"][y, x]
        rgb_ref = res["recon_matched"][y, x]
        rgb_org = self.rgb[y, x]
        lines = [
            f"输出像素 ({x}, {y})",
            f"亮度 Y = {y_val:.1f}",
            "",
            f"引用的色度样本 (还原约定={self.up_siting}, {self.method}):",
        ]
        for ci, cj, wgt in sources:
            lines.append(
                f"  [{ci},{cj}] 位置({2*ci+dx:.1f},{2*cj+dy:.1f}) "
                f"权重{wgt:.2f}  Cr={res['Cr'][cj,ci]:.1f} "
                f"Cb={res['Cb'][cj,ci]:.1f}")
        lines += [
            f"插值结果  Cr={cr_up:.1f}  Cb={cb_up:.1f}",
            "",
            f"原始 RGB   = ({rgb_org[0]:.0f},{rgb_org[1]:.0f},{rgb_org[2]:.0f})",
            f"还原 RGB   = ({rgb_out[0]:.0f},{rgb_out[1]:.0f},{rgb_out[2]:.0f})",
            f"总误差     = {tuple(np.round(rgb_out-rgb_org).astype(int))}",
            "",
            "误差分解:",
            f"  颜色损失 = {tuple(np.round(rgb_ref-rgb_org).astype(int))}"
            "  (约定一致时也有)",
            f"  错位     = {tuple(np.round(rgb_out-rgb_ref).astype(int))}"
            "  (约定不一致额外引入)",
        ]
        self.ax_info.clear()
        self.ax_info.axis("off")
        self.ax_info.text(0.02, 0.98, "\n".join(lines), va="top",
                          fontsize=9)
        self.fig.canvas.draw_idle()

    def _clear_markers(self):
        for m in self._markers:
            try:
                m.remove()
            except (ValueError, NotImplementedError):
                pass
        self._markers = []

    # ------------------------------------------------------------ 按键

    def _on_key(self, ev):
        if ev.key == "d":
            self.down_siting = self._cycle(self.down_siting)
        elif ev.key == "u":
            self.up_siting = self._cycle(self.up_siting)
        elif ev.key == "m":
            self.method = "nearest" if self.method == "bilinear" else "bilinear"
        elif ev.key == "g":
            self.show_grid = not self.show_grid
        elif ev.key == "r":
            for ax in (self.ax_orig, self.ax_recon, self.ax_y):
                ax.set_xlim(-0.5, self.w - 0.5)
                ax.set_ylim(self.h - 0.5, -0.5)
            self.fig.canvas.draw_idle()
            return
        elif ev.key == "h":
            self._print_help()
            return
        else:
            return
        self.recompute()

    @staticmethod
    def _cycle(siting: str) -> str:
        order = core.SITING_ORDER
        return order[(order.index(siting) + 1) % len(order)]

    @staticmethod
    def _print_help():
        print(__doc__)
