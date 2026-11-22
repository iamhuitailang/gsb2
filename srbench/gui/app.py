"""采样率转换试听台主窗口（tkinter + matplotlib）。"""

from __future__ import annotations

import json
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import numpy as np

from .. import COMMON_RATES, QUALITY_HIGH, QUALITY_LOW
from ..analysis import map_selection_to_output
from ..audio import AudioData
from ..player import Player
from ..resample import resample
from ..signals import PRESETS, build_preset
from ..summary import build_summary, format_summary_text, save_summary, verify_export
from ..wavio import probe_wav, read_wav, write_wav
from .plots import (
    COLOR_HIGH,
    COLOR_LOW,
    COLOR_SRC,
    SpectrogramPlot,
    SpectrumPlot,
    WaveformPlot,
    make_figure,
)
from .style import configure_fonts

configure_fonts()


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("采样率转换试听台 srbench")
        self.root.geometry("1280x860")

        self.src: AudioData | None = None
        self.low = None       # ResampleResult
        self.high = None
        self.target_rate = tk.IntVar(value=22050)
        self.channel_var = tk.IntVar(value=0)
        self.export_bits = tk.IntVar(value=16)
        self.export_format = tk.StringVar(value="PCM")
        self.selection = None  # (t0, t1)
        self.player = Player()

        self._build_toolbar()
        self._build_info_bar()
        self._build_tabs()
        self._build_status()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------ 布局
    def _build_toolbar(self) -> None:
        bar = ttk.Frame(self.root, padding=(8, 6))
        bar.pack(fill="x")

        ttk.Button(bar, text="导入 WAV…", command=self.on_import).pack(side="left")
        ttk.Label(bar, text="生成测试音:").pack(side="left", padx=(12, 4))
        self.preset_box = ttk.Combobox(
            bar, width=22, state="readonly",
            values=[f"{k} — {v}" for k, v in PRESETS.items()],
        )
        self.preset_box.current(0)
        self.preset_box.pack(side="left")
        ttk.Button(bar, text="生成", command=self.on_generate).pack(side="left", padx=4)

        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=10)
        ttk.Label(bar, text="目标采样率:").pack(side="left")
        self.rate_box = ttk.Combobox(
            bar, width=8, state="readonly",
            values=[str(r) for r in COMMON_RATES],
            textvariable=self.target_rate,
        )
        self.rate_box.pack(side="left", padx=4)
        ttk.Button(bar, text="执行转换", command=self.on_convert).pack(side="left", padx=6)

        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=10)
        ttk.Button(bar, text="导出 WAV + 摘要…", command=self.on_export).pack(side="left")
        ttk.Button(bar, text="回读核对…", command=self.on_verify).pack(side="left", padx=4)

    def _build_info_bar(self) -> None:
        self.info_var = tk.StringVar(value="未加载音频。导入 WAV 或生成测试音开始。")
        lbl = ttk.Label(self.root, textvariable=self.info_var, padding=(10, 4),
                        background="#f3f4f6", anchor="w")
        lbl.pack(fill="x")

    def _build_tabs(self) -> None:
        nb = ttk.Notebook(self.root)
        nb.pack(fill="both", expand=True, padx=8, pady=6)

        self._build_wave_tab(nb)
        self._build_spectrum_tab(nb)
        self._build_detail_tab(nb)
        self._build_check_tab(nb)

    def _build_wave_tab(self, nb: ttk.Notebook) -> None:
        tab = ttk.Frame(nb)
        nb.add(tab, text="波形 / 框选")

        ctl = ttk.Frame(tab, padding=4)
        ctl.pack(fill="x")
        ttk.Label(ctl, text="声道:").pack(side="left")
        self.ch_box = ttk.Combobox(ctl, width=4, state="readonly",
                                   textvariable=self.channel_var)
        self.ch_box.pack(side="left", padx=4)
        self.ch_box.bind("<<ComboboxSelected>>", lambda e: self._refresh_channel())
        ttk.Button(ctl, text="试听源", command=lambda: self._play(self.src)).pack(side="left", padx=6)
        ttk.Button(ctl, text="试听低质量", command=lambda: self._play(self.low.audio if self.low else None)).pack(side="left")
        ttk.Button(ctl, text="试听高质量", command=lambda: self._play(self.high.audio if self.high else None)).pack(side="left", padx=6)
        ttk.Button(ctl, text="A/B 对照(先低后高)", command=self.play_ab).pack(side="left")
        ttk.Button(ctl, text="停止", command=self.player.stop).pack(side="left", padx=6)
        self.sel_label = ttk.Label(ctl, text="未框选")
        self.sel_label.pack(side="left", padx=12)

        fig, self.wave_canvas = make_figure(tab, figsize=(11, 5.5))
        self.ax_src, self.ax_low, self.ax_high = fig.subplots(3, 1, sharex=True)
        self.p_src = WaveformPlot(self.ax_src, COLOR_SRC, on_select=self.on_select)
        self.p_low = WaveformPlot(self.ax_low, COLOR_LOW, on_select=self.on_select)
        self.p_high = WaveformPlot(self.ax_high, COLOR_HIGH, on_select=self.on_select)
        self.ax_high.set_xlabel("时间 (s)")

    def _build_spectrum_tab(self, nb: ttk.Notebook) -> None:
        tab = ttk.Frame(nb)
        nb.add(tab, text="频谱 / 声谱图")
        fig, self.spec_canvas = make_figure(tab, figsize=(11, 6))
        ax_spec, ax_specgram = fig.subplots(2, 1)
        self.spectrum_plot = SpectrumPlot(ax_spec)
        self.spectrogram_plot = SpectrogramPlot(ax_specgram)

    def _build_detail_tab(self, nb: ttk.Notebook) -> None:
        tab = ttk.Frame(nb)
        nb.add(tab, text="采样点对照")
        self.detail_text = tk.Text(tab, wrap="word", height=24, font=("Menlo", 11))
        self.detail_text.pack(fill="both", expand=True, padx=6, pady=6)

    def _build_check_tab(self, nb: ttk.Notebook) -> None:
        tab = ttk.Frame(nb)
        nb.add(tab, text="检查结论 / 摘要")
        self.check_text = tk.Text(tab, wrap="word", font=("Menlo", 11))
        self.check_text.pack(fill="both", expand=True, padx=6, pady=6)

    def _build_status(self) -> None:
        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(self.root, textvariable=self.status_var, padding=(10, 3),
                  relief="sunken", anchor="w").pack(fill="x", side="bottom")

    # ------------------------------------------------------------ 动作
    def on_import(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 WAV", filetypes=[("WAV 文件", "*.wav"), ("所有文件", "*.*")])
        if not path:
            return
        try:
            audio = read_wav(path)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("读取失败", str(e))
            return
        self._set_source(audio)
        self.status_var.set(f"已导入 {path}")

    def on_generate(self) -> None:
        key = self.preset_box.get().split(" — ")[0]
        audio = build_preset(key)
        self._set_source(audio)
        self.status_var.set(f"已生成测试音: {PRESETS[key]}")

    def _set_source(self, audio: AudioData) -> None:
        self.player.stop()
        self.src = audio
        self.low = self.high = None
        self.selection = None
        self.channel_var.set(0)
        self.ch_box["values"] = [str(i) for i in range(audio.channels)]
        self.info_var.set(
            f"{audio.name}｜{audio.sample_rate} Hz｜{audio.channels} 声道｜"
            f"{audio.n_frames} 采样点｜时长 {audio.duration:.6f} s｜"
            f"{audio.sample_format}/{audio.bit_depth}bit"
        )
        self.p_src.set_audio(audio, f"源波形（{audio.sample_rate}Hz，蓝）")
        self.ax_low.clear(); self.ax_high.clear()
        self.ax_low.set_title("低质量输出（转换后显示）", fontsize=10, loc="left")
        self.ax_high.set_title("高质量输出（转换后显示）", fontsize=10, loc="left")
        self.wave_canvas.draw()
        self.detail_text.delete("1.0", "end")
        self.check_text.delete("1.0", "end")

    def on_convert(self) -> None:
        if self.src is None:
            messagebox.showwarning("提示", "请先导入或生成源音频")
            return
        rate = int(self.target_rate.get())
        try:
            self.low = resample(self.src, rate, QUALITY_LOW)
            self.high = resample(self.src, rate, QUALITY_HIGH)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("转换失败", str(e))
            return
        self._render_outputs()
        self._render_spectrum()
        self._render_checks()
        self.status_var.set(
            f"转换完成 {self.src.sample_rate}->{rate}Hz｜低质量 {self.low.audio.n_frames} 点 / "
            f"高质量 {self.high.audio.n_frames} 点（同一取整规则）")

    def _render_outputs(self) -> None:
        ch = self.channel_var.get()
        self.p_low.set_audio(self.low.audio, f"低质量输出（{self.low.audio.sample_rate}Hz，红，无抗混叠）")
        self.p_high.set_audio(self.high.audio, f"高质量输出（{self.high.audio.sample_rate}Hz，绿，多相 FIR）")
        self.p_low.set_channel(ch)
        self.p_high.set_channel(ch)
        self.wave_canvas.draw()

    def _refresh_channel(self) -> None:
        if self.src is None:
            return
        ch = self.channel_var.get()
        self.p_src.set_channel(ch)
        if self.low:
            self.p_low.set_channel(ch)
            self.p_high.set_channel(ch)
        self.wave_canvas.draw()
        if self.low:
            self._render_spectrum()

    def _render_spectrum(self) -> None:
        ch = self.channel_var.get()
        self.spectrum_plot.plot(self.src, self.low.audio, self.high.audio, channel=ch)
        # 声谱图默认展示低质量输出（折叠最明显）
        self.spectrogram_plot.plot(self.low.audio, channel=ch)
        self.spec_canvas.draw()

    def _render_checks(self) -> None:
        summary = build_summary(self.src, self.low, self.high)
        self.check_text.delete("1.0", "end")
        self.check_text.insert("1.0", format_summary_text(summary))

    def on_select(self, t0: float, t1: float) -> None:
        if self.src is None:
            return
        self.selection = (t0, t1)
        self.sel_label.config(text=f"框选 {t0:.5f}s – {t1:.5f}s（{t1-t0:.5f}s）")
        self._render_detail(t0, t1)

    def _render_detail(self, t0: float, t1: float) -> None:
        sr = self.src.sample_rate
        i0 = max(0, int(round(t0 * sr)))
        i1 = min(self.src.n_frames, int(round(t1 * sr)))
        lines = [f"框选区间：{t0:.6f}s – {t1:.6f}s",
                 f"源采样点索引：[{i0}, {i1})，共 {i1-i0} 点 @ {sr}Hz", ""]
        ch = self.channel_var.get()

        if self.low is None:
            lines.append("（执行转换后显示输出采样点位置映射）")
        else:
            dst = self.low.audio.sample_rate
            o0, o1, src_pos = map_selection_to_output(i0, i1, sr, dst)
            lines.append(f"目标采样率 {dst}Hz，映射到输出采样点 [{o0}, {o1})，共 {o1-o0} 点")
            lines.append("取整规则：n_out = ceil(n_in * up / down)")
            lines.append("")
            lines.append("输出采样点 -> 对应源分数位置 -> 源/低质量/高质量取值：")
            low_x = self.low.audio.samples
            high_x = self.high.audio.samples
            src_x = self.src.samples
            for j, k in enumerate(range(o0, min(o1, o0 + 24))):
                sp = src_pos[j]
                ia = int(np.floor(sp))
                ib = min(ia + 1, self.src.n_frames - 1)
                sv = src_x[ia, ch] if 0 <= ia < self.src.n_frames else float("nan")
                lv = low_x[k, ch] if k < low_x.shape[0] else float("nan")
                hv = high_x[k, ch] if k < high_x.shape[0] else float("nan")
                lines.append(
                    f"  out[{k:6d}] <- src[{sp:9.3f}] (i{ia},{ib}) | "
                    f"源 {sv:+.4f} | 低 {lv:+.4f} | 高 {hv:+.4f}"
                )
            if o1 - o0 > 24:
                lines.append(f"  …（其余 {o1-o0-24} 点省略）")

            # 在波形上标记输出采样点对应的源位置
            mark_times = src_pos[:24] / sr
            self.p_src.mark_samples(mark_times)
            self.wave_canvas.draw()
        self.detail_text.delete("1.0", "end")
        self.detail_text.insert("1.0", "\n".join(lines))

    def _play(self, audio: AudioData | None) -> None:
        if audio is None:
            messagebox.showinfo("提示", "该音频还未生成，请先执行转换")
            return
        # 若有框选，只播放框选片段
        if self.selection is not None:
            t0, t1 = self.selection
            audio = audio.slice_time(t0, t1)
        self.player.play(audio)
        self.status_var.set(f"正在试听：{audio.name}（{audio.sample_rate}Hz {audio.duration:.3f}s）")

    def play_ab(self) -> None:
        if self.low is None:
            messagebox.showinfo("提示", "请先执行转换")
            return
        self.root.after(0, lambda: self._play(self.low.audio))
        # 低质量播完后播高质量（按片段时长调度）
        seg = self.low.audio
        if self.selection is not None:
            t0, t1 = self.selection
            seg = seg.slice_time(t0, t1)
        delay_ms = int(seg.duration * 1000) + 150
        self.root.after(delay_ms, lambda: self._play(self.high.audio))

    def on_export(self) -> None:
        if self.low is None:
            messagebox.showwarning("提示", "请先执行转换")
            return
        outdir = filedialog.askdirectory(title="选择导出目录")
        if not outdir:
            return
        from pathlib import Path
        outdir = Path(outdir)
        rate = self.low.audio.sample_rate
        bits = int(self.export_bits.get())
        fmt = self.export_format.get()
        stem = self.src.name
        exports = {}
        try:
            for rr, tag in ((self.low, "low"), (self.high, "high")):
                p = outdir / f"{stem}_{rate}_{tag}.wav"
                write_wav(p, rr.audio, bits=bits, sample_format=fmt,
                          extensible=rr.audio.channels > 2)
                exports[tag] = verify_export(p, rr.audio, fmt, bits)
            summary = build_summary(self.src, self.low, self.high,
                                    export_info=exports["high"])
            save_summary(summary, outdir / f"{stem}_{rate}_summary.txt")
            save_summary(summary, outdir / f"{stem}_{rate}_summary.json")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("导出失败", str(e))
            return
        ok = exports["low"]["verified"] and exports["high"]["verified"]
        self.check_text.insert("end", "\n\n" + "=" * 50 + "\n导出回读核对："
                               + ("全部通过 ✅" if ok else "存在不一致 ❌"))
        messagebox.showinfo("导出完成",
                            f"已导出到 {outdir}\n回读核对：{'全部通过' if ok else '存在不一致'}")
        self.status_var.set(f"导出完成：{outdir}")

    def on_verify(self) -> None:
        path = filedialog.askopenfilename(
            title="选择要核对的 WAV", filetypes=[("WAV 文件", "*.wav")])
        if not path:
            return
        try:
            header = probe_wav(path)
            audio = read_wav(path)
            info = verify_export(path, audio, audio.sample_format,
                                 audio.bit_depth or 16)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("核对失败", str(e))
            return
        lines = ["导出文件独立回读核对", "=" * 50, json.dumps(header, indent=2, ensure_ascii=False), ""]
        for c in info["checks"]:
            lines.append(f"[{'OK' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
        self.check_text.delete("1.0", "end")
        self.check_text.insert("1.0", "\n".join(lines))
        self.status_var.set("回读核对：" + ("全部通过" if info["verified"] else "存在不一致"))

    def _on_close(self) -> None:
        self.player.shutdown()
        self.root.destroy()


def run() -> None:
    root = tk.Tk()
    App(root)
    root.mainloop()
