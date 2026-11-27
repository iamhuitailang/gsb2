"""转换项目的保存/加载与失败恢复。

项目目录结构：
<workspace>/<project_id>/
  project.json          项目配置与分析结果（原子写入）
  project.json.bak      上一次成功保存的版本
  frames/               抽取的预览帧 JPEG
  export/               导出视频与时间映射清单
  convert.log           最近一次转码日志
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from typing import Any

PROJECT_VERSION = 1


class ProjectError(RuntimeError):
    pass


def new_project(source_path: str) -> dict[str, Any]:
    return {
        "version": PROJECT_VERSION,
        "id": uuid.uuid4().hex[:12],
        "created_at": time.time(),
        "updated_at": time.time(),
        "source": {
            "path": os.path.abspath(source_path),
            "probe": None,          # ffprobe 分析结果
            "analyzed": False,
            "analyze_error": None,  # 分析失败也保留错误信息，已完成部分不丢
        },
        "settings": {
            "dst_fps": 30.0,
            "speed": 1.0,
            "method": "nearest",    # nearest | blend
            "keep_pitch": True,
            "video_codec": "libx264",
            "crf": 18,
            "preset": "medium",
        },
        # 每种 (method, dst_fps, speed) 组合的分析缓存
        "mapping_cache": {},
        "exports": [],
    }


def project_dir(workspace: str, project_id: str) -> str:
    return os.path.join(workspace, project_id)


def project_path(workspace: str, project_id: str) -> str:
    return os.path.join(project_dir(workspace, project_id), "project.json")


def save_project(workspace: str, project: dict) -> str:
    """原子写入：先写临时文件再 replace；旧版本保留为 .bak。"""

    pid = project["id"]
    pdir = project_dir(workspace, pid)
    os.makedirs(pdir, exist_ok=True)
    os.makedirs(os.path.join(pdir, "frames"), exist_ok=True)
    os.makedirs(os.path.join(pdir, "export"), exist_ok=True)

    project["updated_at"] = time.time()
    target = project_path(workspace, pid)

    fd, tmp = tempfile.mkstemp(dir=pdir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(project, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # 新内容先完整落临时文件；成功后才把当前正式版本降为 .bak
        if os.path.exists(target):
            bak = target + ".bak"
            if os.path.exists(bak):
                os.unlink(bak)
            os.replace(target, bak)
        os.replace(tmp, target)
    except OSError as e:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise ProjectError(f"项目保存失败: {e}") from e
    return target


def load_project(workspace: str, project_id: str) -> dict:
    """加载项目；主文件损坏时自动回退 .bak（失败恢复）。"""

    target = project_path(workspace, project_id)
    for candidate in (target, target + ".bak"):
        if not os.path.exists(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8") as f:
                project = json.load(f)
            _validate(project)
            return project
        except (json.JSONDecodeError, OSError, KeyError) as e:
            last_err = e
            continue
    raise ProjectError(f"项目无法加载（主文件与备份均损坏或不存在）: {project_id}")


def list_projects(workspace: str) -> list[dict]:
    if not os.path.isdir(workspace):
        return []
    out = []
    for name in sorted(os.listdir(workspace)):
        pj = os.path.join(workspace, name, "project.json")
        if not os.path.exists(pj):
            continue
        try:
            with open(pj, encoding="utf-8") as f:
                p = json.load(f)
            out.append({
                "id": p["id"],
                "source": p["source"]["path"],
                "updated_at": p["updated_at"],
                "analyzed": p["source"]["analyzed"],
            })
        except (json.JSONDecodeError, OSError, KeyError):
            continue
    return out


def _validate(project: dict) -> None:
    for key in ("version", "id", "source", "settings"):
        if key not in project:
            raise KeyError(key)


def cache_key(settings: dict) -> str:
    return (
        f"{settings['method']}|fps={float(settings['dst_fps']):.6f}"
        f"|speed={float(settings['speed']):.6f}"
    )
