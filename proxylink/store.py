"""数据模型与 JSON 持久化。

状态文件默认保存在工作目录的 ``.proxylink/state.json``，重启后
素材关联、标定、剪辑点、播放头全部保留。所有路径按绝对路径登记，
同名文件位于不同目录时 id 不同，天然可以区分。
"""

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

from . import SCHEMA_VERSION
from .errors import MediaNotFoundError
from .mapping import Mapping


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def media_id_for(path):
    """素材 id = 规范化绝对路径，保证不同目录下同名文件互不冲突。

    realpath 解析符号链接（如 macOS 的 /tmp -> /private/tmp），
    使同一文件无论用哪种路径写法都得到同一个 id。
    """
    return os.path.realpath(os.path.abspath(os.path.expanduser(path)))


@dataclass
class Media:
    """一条已登记素材（原片或代理）。"""

    id: str
    path: str
    filename: str
    registered_at: str
    duration: float
    width: int
    height: int
    fps: float
    codec: str
    profile: str
    pix_fmt: str
    nb_frames: int
    has_audio: bool
    container: str
    bit_rate: int
    size_bytes: int
    partial_sha256: str
    video_streams: list = field(default_factory=list)
    audio_streams: list = field(default_factory=list)

    @property
    def exists(self):
        return os.path.isfile(self.path)

    @property
    def resolution(self):
        return f"{self.width}x{self.height}"

    @classmethod
    def from_probe(cls, path, info):
        ap = media_id_for(path)
        return cls(
            id=ap,
            path=ap,
            filename=os.path.basename(ap),
            registered_at=utc_now_iso(),
            duration=info["duration"],
            width=info["width"],
            height=info["height"],
            fps=info["fps"],
            codec=info["codec"],
            profile=info.get("profile"),
            pix_fmt=info.get("pix_fmt"),
            nb_frames=info.get("nb_frames"),
            has_audio=info.get("has_audio", False),
            container=info.get("container"),
            bit_rate=info.get("bit_rate"),
            size_bytes=info["file_size"],
            partial_sha256=info["partial_sha256"],
            video_streams=info.get("video_streams", []),
            audio_streams=info.get("audio_streams", []),
        )

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class Link:
    """原片与代理的挂接关系及标定。"""

    id: str
    original_id: str
    proxy_id: str
    created_at: str
    updated_at: str
    calibration: dict = field(default_factory=dict)  # Mapping.to_dict()
    label: str = ""

    def mapping(self, media_by_id):
        original = media_by_id.get(self.original_id)
        proxy = media_by_id.get(self.proxy_id)
        if original is None or proxy is None:
            raise MediaNotFoundError("挂接引用的素材记录缺失")
        return Mapping.from_dict(self.calibration, original, proxy)


@dataclass
class CutPoint:
    """剪辑点：以原片时间为准，保留完整换算溯源。"""

    id: str
    link_id: str
    original_time: float
    proxy_time: float
    rate: float
    label: str
    created_at: str
    # 溯源：由哪支代理、代理上的哪个时间、用什么标定换算而来
    source: dict = field(default_factory=dict)
    reliable: bool = True
    note: str = ""


@dataclass
class Session:
    """播放头状态：切换原片/代理后仍指向同一画面。"""

    link_id: str
    side: str = "original"          # "original" | "proxy"
    original_time: float = 0.0
    proxy_time: float = 0.0
    stopped: bool = False
    stop_reason: str = ""


@dataclass
class ProjectState:
    schema_version: int
    created_at: str
    updated_at: str
    media: dict = field(default_factory=dict)      # id -> Media
    links: dict = field(default_factory=dict)      # id -> Link
    cut_points: list = field(default_factory=list)
    session: object = None

    def get_media(self, media_id):
        m = self.media.get(media_id)
        if m is None:
            raise MediaNotFoundError(f"未登记的素材: {media_id}")
        return m

    def find_by_filename(self, filename):
        return [m for m in self.media.values() if m.filename == filename]

    def links_for_media(self, media_id):
        return [lk for lk in self.links.values()
                if lk.original_id == media_id or lk.proxy_id == media_id]

    def to_dict(self):
        return {
            "schema_version": self.schema_version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "media": {k: v.to_dict() for k, v in self.media.items()},
            "links": {k: asdict(v) for k, v in self.links.items()},
            "cut_points": [asdict(c) for c in self.cut_points],
            "session": asdict(self.session) if self.session else None,
        }

    @classmethod
    def from_dict(cls, d):
        state = cls(
            schema_version=d.get("schema_version", SCHEMA_VERSION),
            created_at=d.get("created_at", utc_now_iso()),
            updated_at=d.get("updated_at", utc_now_iso()),
            media={k: Media.from_dict(v) for k, v in d.get("media", {}).items()},
            links={k: Link(**v) for k, v in d.get("links", {}).items()},
            cut_points=[CutPoint(**c) for c in d.get("cut_points", [])],
        )
        sd = d.get("session")
        if sd:
            state.session = Session(**sd)
        return state


class Store:
    """状态文件读写。"""

    DIRNAME = ".proxylink"
    STATE_NAME = "state.json"

    def __init__(self, base_dir="."):
        self.base_dir = os.path.abspath(base_dir)
        self.dir = os.path.join(self.base_dir, self.DIRNAME)
        self.path = os.path.join(self.dir, self.STATE_NAME)

    def exists(self):
        return os.path.isfile(self.path)

    def load(self):
        if not self.exists():
            return ProjectState(
                schema_version=SCHEMA_VERSION,
                created_at=utc_now_iso(),
                updated_at=utc_now_iso(),
            )
        with open(self.path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return ProjectState.from_dict(data)

    def save(self, state):
        os.makedirs(self.dir, exist_ok=True)
        state.updated_at = utc_now_iso()
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state.to_dict(), fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
