"""试听播放：写临时 WAV，用 macOS afplay 后台播放，可停止。

播放前后做短淡入淡出，避免截断产生咔哒声。
"""

from __future__ import annotations

import os
import subprocess
import tempfile

import numpy as np

from .audio import AudioData
from .wavio import write_wav_simple


def _apply_fade(audio: AudioData, fade_ms: float = 5.0) -> AudioData:
    n = audio.n_frames
    fade_n = min(n // 4, int(round(fade_ms / 1000.0 * audio.sample_rate)))
    if fade_n <= 1:
        return audio
    samples = audio.samples.copy()
    ramp = np.linspace(0.0, 1.0, fade_n)
    samples[:fade_n, :] *= ramp[:, None]
    samples[-fade_n:, :] *= ramp[::-1][:, None]
    return AudioData(samples, audio.sample_rate, name=audio.name)


class Player:
    """一次只播一个片段，停止时杀掉 afplay 进程。"""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._tmpdir = tempfile.mkdtemp(prefix="srbench_play_")

    def play(self, audio: AudioData) -> None:
        self.stop()
        faded = _apply_fade(audio)
        path = os.path.join(self._tmpdir, f"play_{audio.sample_rate}_{audio.n_frames}.wav")
        # afplay 对 16-bit PCM 兼容性最好
        write_wav_simple(path, faded, bits=16, sample_format="PCM")
        self._proc = subprocess.Popen(
            ["afplay", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def stop(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None

    @property
    def is_playing(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def shutdown(self) -> None:
        self.stop()
