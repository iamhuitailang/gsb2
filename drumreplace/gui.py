"""Interactive local workbench for drum-sample replacement.

Run with:  python -m drumreplace.gui

Features (mapped to the task brief):
  * markers show detected hits with class + velocity, draggable in time and
    deletable as false alarms; right-click a marker to toggle drum class;
  * dry/wet slider crossfades original vs replaced audio;
  * three view/playback modes -- original / processed / difference -- keep
    the same playhead position when switched;
  * clicking a marker opens a zoomed local panel showing where the new sample
    lands relative to the original transient;
  * explicit head/tail boundary rules are shown after each render;
  * export WAV + marker CSV + a verification report against ground truth.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import List, Optional

import numpy as np
import tkinter as tk
from tkinter import ttk, messagebox

from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

from .synthesis import SAMPLE_RATE, Event, build_practice_scene, build_sample_library
from .detection import DetectionParams, detect_hits
from .replacement import render_replacement, verify
from .io_utils import export_wav, export_markers, export_report

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# marker styling per (drum, velocity)
STYLE = {
    ("kick", "hard"):  ("#c0392b", "v"),
    ("kick", "soft"):  ("#e67e22", "v"),
    ("snare", "hard"): ("#1f618d", "o"),
    ("snare", "soft"): ("#5dade2", "o"),
}
PLAY_MODES = ("original", "processed", "difference")


class DrumApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Drum sample replacement workbench")
        root.geometry("1180x780")

        # audio state -------------------------------------------------------
        self.original, self.ground_truth = build_practice_scene()
        self.library = build_sample_library()
        self.params = DetectionParams()
        self.events: List[Event] = detect_hits(self.original, self.params)
        self.dry_wet = tk.DoubleVar(value=0.0)
        self.mode = tk.StringVar(value="processed")
        self.playhead = 0.0
        self.selected: Optional[int] = None
        self._play_thread: Optional[threading.Thread] = None
        self._stream = None
        self._render_cache()

        self._build_widgets()
        self._draw_all()

    # ------------------------------------------------------------------ #
    # rendering
    # ------------------------------------------------------------------ #
    def _render_cache(self) -> None:
        self.render = render_replacement(
            self.original, self.events, dry_wet=self.dry_wet.get(),
            library=self.library,
        )
        self.mode_audio = {
            "original": self._pad(self.original),
            "processed": self.render.mix,
            "difference": self.render.difference,
        }

    def _pad(self, x: np.ndarray) -> np.ndarray:
        out = np.zeros_like(self.render.mix)
        out[:len(x)] = x
        return out

    # ------------------------------------------------------------------ #
    # layout
    # ------------------------------------------------------------------ #
    def _build_widgets(self) -> None:
        top = ttk.Frame(self.root, padding=6)
        top.pack(fill="x")

        ttk.Button(top, text="重新检测", command=self.redetect).pack(side="left")
        ttk.Label(top, text="检测阈值").pack(side="left", padx=(14, 2))
        self.thr = tk.DoubleVar(value=self.params.flux_threshold)
        ttk.Scale(top, from_=1.0, to=3.0, length=120, variable=self.thr,
                  command=lambda _=None: self.redetect()).pack(side="left")

        ttk.Label(top, text="  干湿比 (干=原声)").pack(side="left", padx=(18, 2))
        ttk.Scale(top, from_=0.0, to=1.0, length=160, variable=self.dry_wet,
                  command=self._on_drywet).pack(side="left")

        ttk.Label(top, text="  模式").pack(side="left", padx=(18, 2))
        ttk.Combobox(top, textvariable=self.mode, values=list(PLAY_MODES),
                     state="readonly", width=10).pack(side="left")
        ttk.Button(top, text="切换模式(保留播放头)",
                   command=self._switch_mode).pack(side="left", padx=6)

        ttk.Button(top, text="播放", command=self.play).pack(side="left", padx=(18, 2))
        ttk.Button(top, text="停止", command=self.stop).pack(side="left")
        ttk.Button(top, text="导出 WAV+标记+报告",
                   command=self.export).pack(side="right")

        # main waveform
        self.fig = Figure(figsize=(11, 4.2), dpi=100)
        self.ax_main = self.fig.add_subplot(211)
        self.ax_zoom = self.fig.add_subplot(212)
        self.fig.subplots_adjust(hspace=0.45, top=0.93, bottom=0.08)
        self.canvas = FigureCanvasTkAgg(self.fig, master=self.root)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.canvas.mpl_connect("button_press_event", self._on_mouse_down)
        self.canvas.mpl_connect("button_release_event", self._on_mouse_up)

        bottom = ttk.Frame(self.root, padding=4)
        bottom.pack(fill="x")
        self.status = tk.StringVar()
        ttk.Label(bottom, textvariable=self.status).pack(side="left")
        ttk.Label(bottom, text="  左键拖动标记改时间 · 右键删除误报 · 中键切换鼓类 · 点击标记看局部").pack(side="right")

    # ------------------------------------------------------------------ #
    # drawing
    # ------------------------------------------------------------------ #
    def _current_audio(self) -> np.ndarray:
        return self.mode_audio[self.mode.get()]

    def _draw_all(self) -> None:
        self._draw_main()
        self._draw_zoom()
        self._update_status()

    def _draw_main(self) -> None:
        ax = self.ax_main
        ax.clear()
        audio = self._current_audio()
        t = np.arange(len(audio)) / SAMPLE_RATE
        ax.plot(t, audio, linewidth=0.5, color="#34495e")
        ax.set_title(f"{self.mode.get()}  ({len(self.events)} markers)")
        ax.set_xlim(0, len(audio) / SAMPLE_RATE)
        ax.set_ylabel("amplitude")

        for idx, ev in enumerate(self.events):
            color, marker = STYLE[(ev.drum, ev.velocity)]
            ax.axvline(ev.time, color=color, alpha=0.45, linewidth=0.8)
            ax.plot(ev.time, 0.9, marker=marker, color=color, markersize=9,
                    pickradius=7, picker=True,
                    markeredgecolor="black" if idx == self.selected else "none")

        self.play_line = ax.axvline(self.playhead, color="red", linewidth=1.2)
        self.canvas.draw_idle()

    def _draw_zoom(self) -> None:
        ax = self.ax_zoom
        ax.clear()
        if self.selected is None or self.selected >= len(self.events):
            ax.set_title("Click a marker above to inspect local detail")
            self.canvas.draw_idle()
            return
        ev = self.events[self.selected]
        half = 0.12
        lo, hi = max(0.0, ev.time - half), ev.time + half
        s0, s1 = int(lo * SAMPLE_RATE), int(hi * SAMPLE_RATE)

        t = np.arange(s0, min(s1, len(self.original))) / SAMPLE_RATE
        ax.plot(t, self.original[s0:s1], color="#7f8c8d",
                linewidth=0.8, label="original")
        proc = self.mode_audio["processed"]
        s1p = min(s1, len(proc))
        ax.plot(t[:s1p - s0], proc[s0:s1p], color="#27ae60",
                linewidth=0.8, alpha=0.8, label="replacement")
        ax.axvline(ev.time, color="red", linestyle="--", linewidth=1,
                   label=f"marker {ev.time:.3f}s")

        # show exactly where the replacement sample starts and its tail span
        voice = self.library[(ev.drum, ev.velocity)]
        tail_end = ev.time + len(voice) / SAMPLE_RATE
        ax.axvspan(ev.time, min(tail_end, hi), color="#27ae60", alpha=0.12,
                   label="new sample tail")
        ax.set_title(f"local: {ev.drum}/{ev.velocity} @ {ev.time:.3f}s · "
                     f"sample tail ends {tail_end:.3f}s")
        ax.set_xlabel("time (sec)")
        ax.legend(fontsize=7, loc="upper right")
        self.canvas.draw_idle()

    def _update_status(self) -> None:
        r = self.render
        self.status.set(
            f"模式={self.mode.get()}  播放头={self.playhead:.3f}s  "
            f"峰值 {r.peak_db_before:.2f}→{r.peak_db_after:.2f} dBFS  "
            f"头裁剪={r.clipped_head_samples}  尾延伸={r.dropped_tail_samples}样本"
        )

    # ------------------------------------------------------------------ #
    # marker interaction
    # ------------------------------------------------------------------ #
    def _marker_at(self, x: float) -> Optional[int]:
        """Index of the marker nearest x within 12 ms, else None."""
        best, best_dt = None, 0.012
        for idx, ev in enumerate(self.events):
            dt = abs(ev.time - x)
            if dt < best_dt:
                best, best_dt = idx, dt
        return best

    def _on_mouse_down(self, event) -> None:
        if event.inaxes != self.ax_main or event.xdata is None:
            return
        idx = self._marker_at(event.xdata)
        if idx is None:
            if event.button == 1:  # empty space: move playhead
                self.playhead = float(event.xdata)
                self.play_line.set_xdata([self.playhead, self.playhead])
                self.canvas.draw_idle()
                self._update_status()
            return

        if event.button == 3:                       # right: delete false alarm
            del self.events[idx]
            self.selected = None
            self._after_edit(None)
        elif event.button == 2:                     # middle: toggle drum class
            ev = self.events[idx]
            ev.drum = "snare" if ev.drum == "kick" else "kick"
            self._after_edit(idx)
        else:                                       # left: begin drag / select
            self.selected = idx
            self._drag_idx = idx

    def _on_mouse_up(self, event) -> None:
        idx = getattr(self, "_drag_idx", None)
        self._drag_idx = None
        if idx is None or event.inaxes != self.ax_main or event.xdata is None:
            return
        # relocate to the release position; a click without movement is a
        # harmless no-op since it lands back on the same time
        self.events[idx].time = float(np.clip(event.xdata, 0.0, None))
        self.selected = idx
        self._after_edit(idx)

    def _after_edit(self, select: Optional[int]) -> None:
        self.events.sort(key=lambda e: e.time)
        if select is not None:
            self.selected = min(select, len(self.events) - 1)
        self._render_cache()
        self._draw_all()

    # ------------------------------------------------------------------ #
    # controls
    # ------------------------------------------------------------------ #
    def _on_drywet(self, _=None) -> None:
        self._render_cache()
        self._draw_all()

    def _switch_mode(self) -> None:
        # keep playhead position across mode switches
        i = (PLAY_MODES.index(self.mode.get()) + 1) % len(PLAY_MODES)
        self.mode.set(PLAY_MODES[i])
        self._draw_all()

    def redetect(self) -> None:
        self.params.flux_threshold = float(self.thr.get())
        self.events = detect_hits(self.original, self.params)
        self.selected = None
        self._render_cache()
        self._draw_all()

    # ------------------------------------------------------------------ #
    # playback (sounddevice if available, afplay fallback)
    # ------------------------------------------------------------------ #
    def play(self) -> None:
        self.stop()
        audio = self._current_audio()
        start_sample = int(self.playhead * SAMPLE_RATE)
        segment = np.ascontiguousarray(audio[start_sample:], dtype=np.float32)

        def run():
            try:
                import sounddevice as sd
                self._stream = sd.play(segment, SAMPLE_RATE)
                sd.wait()
            except Exception:
                import subprocess, tempfile
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    export_wav(f.name, segment)
                    subprocess.run(["/usr/bin/afplay", f.name], check=False)

        self._play_thread = threading.Thread(target=run, daemon=True)
        self._play_thread.start()

    def stop(self) -> None:
        try:
            import sounddevice as sd
            sd.stop()
        except Exception:
            pass
        self._stream = None

    # ------------------------------------------------------------------ #
    # export + verification
    # ------------------------------------------------------------------ #
    def export(self) -> None:
        DATA_DIR.mkdir(exist_ok=True)
        wav_path = export_wav(DATA_DIR / "replaced.wav", self.render.mix)
        marker_path = export_markers(DATA_DIR / "markers.csv", self.events)
        gt_path = export_markers(DATA_DIR / "ground_truth.csv", self.ground_truth)
        report = verify(self.ground_truth, self.events,
                        self.original, self.render.mix)
        report_path = export_report(DATA_DIR / "verification.txt",
                                    report, self.render)
        messagebox.showinfo(
            "导出完成",
            f"WAV: {wav_path}\n标记: {marker_path}\n真值: {gt_path}\n"
            f"报告: {report_path}\n\n{report.summary()}",
        )


def main() -> None:
    root = tk.Tk()
    DrumApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
