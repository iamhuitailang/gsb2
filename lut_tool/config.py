"""比较配置的保存与加载。

支持保存两套命名配置（槽位 A / B），每套记录两张表的路径与应用顺序。
关键容错要求：**某张表加载失败时，原先已打开的表仍然可用、可查看**——
因此 :func:`load_config` 只负责读配置，表的加载由 :class:`SafeLutLoader`
完成，它在失败时保留上一张有效表而不是抛出后清空界面状态。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .cube import CubeLUT, CubeParseError, parse_cube

CONFIG_VERSION = 1
SLOT_NAMES = ("A", "B")


def default_config_path() -> Path:
    """跨平台的用户配置目录下的本工具配置文件。"""
    base = os.environ.get("XDG_CONFIG_HOME")
    if base:
        root = Path(base)
    elif os.name == "nt":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        root = Path.home() / ".config"
    return root / "lut_tool" / "compare_configs.json"


@dataclass
class CompareConfig:
    """一套比较配置：两张表的路径 + 应用顺序。"""

    name: str = ""
    first_path: str = ""
    second_path: str = ""
    swapped: bool = False  # True 时界面里按 second -> first 应用

    def ordered_paths(self) -> tuple[str, str]:
        """返回实际应用顺序 ``(first, second)`` 的路径。"""
        if self.swapped:
            return self.second_path, self.first_path
        return self.first_path, self.second_path


@dataclass
class ConfigStore:
    slots: dict[str, CompareConfig] = field(default_factory=dict)

    @classmethod
    def empty(cls) -> "ConfigStore":
        return cls(slots={name: CompareConfig(name=name) for name in SLOT_NAMES})


def save_configs(store: ConfigStore, path: str | os.PathLike | None = None) -> Path:
    """原子写入两套配置（先写临时文件再替换，避免半截文件）。"""
    target = Path(path) if path else default_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CONFIG_VERSION,
        "slots": {name: asdict(cfg) for name, cfg in store.slots.items()},
    }
    fd, tmp = tempfile.mkstemp(prefix=".lutcfg-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
    except BaseException:
        os.unlink(tmp)
        raise
    return target


def load_configs(path: str | os.PathLike | None = None) -> ConfigStore:
    """读取配置；文件不存在时返回空配置，损坏时抛出带说明的异常。"""
    target = Path(path) if path else default_config_path()
    if not target.exists():
        return ConfigStore.empty()
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"配置文件损坏，无法解析: {target} ({exc})") from exc

    if not isinstance(payload, dict) or "slots" not in payload:
        raise ValueError("配置文件缺少 slots 结构")

    store = ConfigStore.empty()
    for name in SLOT_NAMES:
        raw = payload["slots"].get(name)
        if not raw:
            continue
        store.slots[name] = CompareConfig(
            name=name,
            first_path=raw.get("first_path", ""),
            second_path=raw.get("second_path", ""),
            swapped=bool(raw.get("swapped", False)),
        )
    return store


@dataclass
class LoadOutcome:
    """一次表加载尝试的结果。"""

    lut: CubeLUT | None
    error: str = ""          # 非空表示失败
    source_path: str = ""

    @property
    def ok(self) -> bool:
        # 注意：失败时 lut 可能仍保留着上一张有效表，
        # 因此必须以 error 为准，不能只判断 lut 是否为 None。
        return self.lut is not None and not self.error


class SafeLutLoader:
    """带记忆的安全加载器：失败时保留上一张有效表。

    用法::

        loader = SafeLutLoader()
        outcome = loader.load(path)   # 失败时 outcome.lut 仍是上一张好表
        current = loader.current      # 永远是“最近一次成功”的表
    """

    def __init__(self, current: CubeLUT | None = None):
        self.current = current
        self.last_error = ""

    def load(self, path: str) -> LoadOutcome:
        if not path:
            return LoadOutcome(self.current, source_path=path or "")
        try:
            lut = parse_cube(path)
        except CubeParseError as exc:
            self.last_error = str(exc)
            # 关键：不清空 self.current，旧效果保持可查看。
            return LoadOutcome(self.current, error=str(exc), source_path=path)
        except OSError as exc:
            self.last_error = f"文件读取失败: {exc}"
            return LoadOutcome(
                self.current, error=self.last_error, source_path=path
            )
        self.current = lut
        self.last_error = ""
        return LoadOutcome(lut, source_path=path)

    def clear(self) -> None:
        self.current = None
        self.last_error = ""
