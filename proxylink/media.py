"""ffprobe 媒体探针、文件签名与重挂接候选校验。

签名设计目标：既能识别"同一文件被移动"（大小 + 首尾哈希不变），
也能在内容被替换（同名但分辨率/时长/编码变了）时给出逐项不符信号，
防止同名文件挂错。
"""

import hashlib
import json
import os
import subprocess

from .errors import ProbeError

_HASH_CHUNK = 4 * 1024 * 1024  # 首尾各取 4 MiB 参与哈希
_DURATION_TOL = 0.1            # 时长容差（秒），另加 2 帧容差
_FPS_TOL = 0.01


def _run_ffprobe(path):
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams",
                path,
            ],
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError as exc:
        raise ProbeError("系统未安装 ffprobe，无法探测媒体文件") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe 超时: {path}") from exc
    if proc.returncode != 0:
        raise ProbeError(f"ffprobe 无法解析 {path}: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe 输出无法解析: {path}") from exc


def _parse_rate(rate):
    """ffprobe 的 ``num/den`` 帧率 -> float，异常返回 None。"""
    if not rate or rate in ("0/0", "N/A"):
        return None
    try:
        num, den = rate.split("/")
        den = float(den)
        if den == 0:
            return None
        return float(num) / den
    except (ValueError, AttributeError):
        return None


def probe_media(path):
    """探测媒体文件，返回结构化信息（不含文件签名）。"""
    if not os.path.isfile(path):
        raise ProbeError(f"文件不存在: {path}")
    data = _run_ffprobe(path)
    streams = data.get("streams", [])
    fmt = data.get("format", {})

    video_streams, audio_streams = [], []
    primary = None
    for st in streams:
        codec_type = st.get("codec_type")
        fps = _parse_rate(st.get("avg_frame_rate")) or _parse_rate(st.get("r_frame_rate"))
        entry = {
            "index": st.get("index"),
            "codec": st.get("codec_name"),
            "profile": st.get("profile"),
            "pix_fmt": st.get("pix_fmt"),
            "width": st.get("width"),
            "height": st.get("height"),
            "fps": round(fps, 4) if fps else None,
            "nb_frames": int(st["nb_frames"]) if st.get("nb_frames", "").isdigit() else None,
            "duration": _safe_float(st.get("duration")),
        }
        if codec_type == "video":
            video_streams.append(entry)
            if primary is None:
                primary = entry
        elif codec_type == "audio":
            audio_streams.append({
                "index": st.get("index"),
                "codec": st.get("codec_name"),
                "channels": st.get("channels"),
                "sample_rate": int(st["sample_rate"]) if st.get("sample_rate", "").isdigit() else None,
                "duration": _safe_float(st.get("duration")),
            })

    if primary is None:
        raise ProbeError(f"文件中没有视频流: {path}")

    duration = _safe_float(fmt.get("duration"))
    if duration is None:
        duration = primary["duration"]
    if duration is None:
        raise ProbeError(f"无法确定时长: {path}")

    nb_frames = primary["nb_frames"]
    fps = primary["fps"]
    if nb_frames is None and fps:
        nb_frames = round(duration * fps)

    return {
        "duration": float(duration),
        "width": primary["width"],
        "height": primary["height"],
        "fps": fps,
        "codec": primary["codec"],
        "profile": primary["profile"],
        "pix_fmt": primary["pix_fmt"],
        "nb_frames": nb_frames,
        "has_audio": bool(audio_streams),
        "container": fmt.get("format_name"),
        "bit_rate": int(fmt["bit_rate"]) if str(fmt.get("bit_rate", "")).isdigit() else None,
        "size_bytes": int(fmt["size"]) if str(fmt.get("size", "")).isdigit() else os.path.getsize(path),
        "video_streams": video_streams,
        "audio_streams": audio_streams,
    }


def _safe_float(value):
    try:
        if value in (None, "N/A"):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def file_signature(path):
    """计算文件签名：大小 + 首/尾块 SHA256。"""
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        if size <= 2 * _HASH_CHUNK:
            # 小文件直接整体哈希，避免首尾块重叠
            while True:
                block = fh.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
        else:
            head = fh.read(_HASH_CHUNK)
            digest.update(head)
            fh.seek(size - _HASH_CHUNK)
            digest.update(fh.read(_HASH_CHUNK))
    return {
        "file_size": size,
        "partial_sha256": digest.hexdigest(),
    }


def full_signature(path):
    """探测 + 签名，登记素材时使用。"""
    info = probe_media(path)
    info.update(file_signature(path))
    return info


def duration_tolerance(fps):
    """时长比对容差：0.1 秒与 2 帧取大者。"""
    frame_tol = 2.0 / fps if fps else 0.0
    return max(_DURATION_TOL, frame_tol)


def verify_candidate(path, expected):
    """逐项校验候选文件是否符合原素材特征。

    返回::

        {"verdict": "match" | "mismatch",
         "checks": [{"field", "expected", "actual", "ok"}, ...],
         "matched": n, "total": m}

    强特征（大小/哈希/分辨率/编码）不符即 mismatch；
    时长在容差内视为一致（转封装可能有微小差异）。
    """
    checks = []
    if not os.path.isfile(path):
        return {
            "verdict": "mismatch",
            "checks": [{"field": "exists", "expected": "file", "actual": "missing", "ok": False}],
            "matched": 0, "total": 1,
        }

    actual_sig = file_signature(path)
    actual_info = probe_media(path)
    # Media 记录中文件大小字段名为 size_bytes
    expected_size = expected.get("file_size", expected.get("size_bytes"))

    def add(field, ok, exp, act):
        checks.append({"field": field, "expected": exp, "actual": act, "ok": bool(ok)})

    add("file_size", actual_sig["file_size"] == expected_size,
        expected_size, actual_sig["file_size"])
    add("partial_sha256", actual_sig["partial_sha256"] == expected["partial_sha256"],
        expected["partial_sha256"], actual_sig["partial_sha256"])
    add("width", actual_info["width"] == expected["width"],
        expected["width"], actual_info["width"])
    add("height", actual_info["height"] == expected["height"],
        expected["height"], actual_info["height"])
    add("codec", actual_info["codec"] == expected["codec"],
        expected["codec"], actual_info["codec"])

    fps_ok = True
    if expected.get("fps") and actual_info.get("fps"):
        fps_ok = abs(actual_info["fps"] - expected["fps"]) <= _FPS_TOL
    add("fps", fps_ok, expected.get("fps"), actual_info.get("fps"))

    dur_ok = True
    if expected.get("duration") is not None:
        tol = duration_tolerance(expected.get("fps"))
        dur_ok = abs(actual_info["duration"] - expected["duration"]) <= tol
    add("duration", dur_ok,
        round(expected["duration"], 3) if expected.get("duration") is not None else None,
        round(actual_info["duration"], 3))

    matched = sum(1 for c in checks if c["ok"])
    # 哈希一致基本可确认同一文件；任一硬特征不符则整体不符
    hard_fields = {"file_size", "partial_sha256", "width", "height", "codec"}
    hard_ok = all(c["ok"] for c in checks if c["field"] in hard_fields)
    verdict = "match" if hard_ok and all(c["ok"] for c in checks) else "mismatch"
    return {"verdict": verdict, "checks": checks, "matched": matched, "total": len(checks)}


def iter_candidate_paths(directory, basename):
    """在目录下递归查找同名候选文件（按修改时间排序）。"""
    results = []
    for root, _dirs, files in os.walk(directory):
        if basename in files:
            p = os.path.join(root, basename)
            results.append((p, os.path.getmtime(p)))
    results.sort(key=lambda x: x[1])
    return [p for p, _ in results]
