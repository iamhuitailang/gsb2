#!/usr/bin/env python3
"""用生成的样音 WAV 端到端验证对齐算法（仅标准库解析 WAV，DSP 逻辑在 JS 侧）。

本脚本只负责把 WAV 解码成原始采样并写成 JSON，供 Node 端的测试读取；
真正的对齐断言在 tests/sample_e2e.js 中完成，保持 DSP 单一实现。
"""
import json
import struct
import sys
import wave


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        ch = w.getnchannels()
        sr = w.getframerate()
        sw = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)
    assert sw == 2, "样音为 16-bit PCM"
    count = n * ch
    samples = struct.unpack("<%dh" % count, raw)
    mono = []
    for i in range(n):
        s = sum(samples[i * ch:(i + 1) * ch]) / ch
        mono.append(s / 32768.0)
    return sr, mono


def main():
    sample_dir = sys.argv[1] if len(sys.argv) > 1 else "public/samples"
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/sample_e2e_data.json"
    with open(sample_dir + "/manifest.json", encoding="utf-8") as f:
        manifest = json.load(f)
    data = {"sampleRate": 48000, "recorders": []}
    for rec in manifest["recorders"]:
        sr, mono = read_wav_mono(sample_dir + "/" + rec["file"])
        # 降采样到 16kHz 供 JS 侧快速分析（块均值），保留足够瞬态细节以精确定位偏移。
        target_sr = 16000
        step = sr / target_sr
        n_out = int(len(mono) / step)
        down = []
        for i in range(n_out):
            a = int(i * step)
            b = max(a + 1, int((i + 1) * step))
            seg = mono[a:b]
            down.append(sum(seg) / len(seg))
        data["recorders"].append({
            "file": rec["file"],
            "origSampleRate": sr,
            "leadSec": rec["leadSec"],
            "driftPpm": rec["driftPpm"],
            "samples": down,
        })
    data["sampleRate"] = target_sr
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f)
    print("wrote", out, "with", len(data["recorders"]), "recorders @", target_sr, "Hz")


if __name__ == "__main__":
    main()
