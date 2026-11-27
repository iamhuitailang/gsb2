"""Adobe ``.cube`` 文本颜色表解析器。

支持：
* 一维 LUT（``LUT_1D_SIZE``，逐通道三列数据）；
* 三维 LUT（``LUT_3D_SIZE``，数据按 R 最慢、B 最快排列）；
* 可选的 ``DOMAIN_MIN`` / ``DOMAIN_MAX`` 声明输入适用范围；
* ``TITLE``、``#`` 注释、空行。

所有错误都抛出 :class:`CubeParseError`，并携带问题所在的 **1 起始行号** 与
该行原文，便于在界面里直接定位到表中的问题行。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

KEYWORDS = {
    "TITLE",
    "LUT_1D_SIZE",
    "LUT_3D_SIZE",
    "DOMAIN_MIN",
    "DOMAIN_MAX",
}


class CubeParseError(ValueError):
    """解析失败，``line`` 为 1 起始行号（无具体行时为 0）。"""

    def __init__(self, message: str, line: int = 0, source: str = ""):
        if line:
            full = f"第 {line} 行: {message}"
            if source:
                full += f" -> {source.strip()!r}"
        else:
            full = message
        super().__init__(full)
        self.message = message
        self.line = line
        self.source = source


@dataclass
class CubeLUT:
    """解析后的颜色表。

    属性
    ----
    kind:
        ``"1D"`` 或 ``"3D"``。
    size:
        每轴采样点数（1D 为行数，3D 为每边点数）。
    domain_min, domain_max:
        输入适用范围，形状均为 ``(3,)``，默认 0.0 / 1.0。
    table:
        1D 时形状 ``(size, 3)``；3D 时形状 ``(size, size, size, 3)``，
        索引顺序为 ``table[r, g, b]``（与 .cube 的 R 最慢、B 最快对应）。
    title, path:
        标题与来源路径（可能为空）。
    """

    kind: str
    size: int
    domain_min: np.ndarray
    domain_max: np.ndarray
    table: np.ndarray
    title: str = ""
    path: str = ""
    metadata: dict = field(default_factory=dict)

    # ------------------------------------------------------------------ 描述
    def describe(self) -> str:
        """单行人类可读描述。"""
        dmin = " ".join(f"{v:.6g}" for v in self.domain_min)
        dmax = " ".join(f"{v:.6g}" for v in self.domain_max)
        if self.kind == "1D":
            shape = f"1D × {self.size} 行"
        else:
            shape = f"3D {self.size}³ = {self.size ** 3} 个采样点"
        name = f"「{self.title}」" if self.title else ""
        return f"{shape}{name} 输入范围 [{dmin}] ~ [{dmax}]"

    def is_in_domain(self, rgb: np.ndarray) -> np.ndarray:
        """返回布尔掩码：像素（最后一维为 RGB）是否落在输入适用范围内。"""
        rgb = np.asarray(rgb, dtype=np.float64)
        lo = self.domain_min <= rgb
        hi = rgb <= self.domain_max
        return np.all(lo & hi, axis=-1)

    def output_range(self) -> tuple[np.ndarray, np.ndarray]:
        """表内实际输出的各通道最小/最大值，形状均为 ``(3,)``。"""
        flat = self.table.reshape(-1, 3)
        return flat.min(axis=0), flat.max(axis=0)


# ---------------------------------------------------------------- 内部工具
def _as_float(tokens: list[str], line_no: int, source: str) -> list[float]:
    values: list[float] = []
    for tok in tokens:
        try:
            v = float(tok)
        except ValueError as exc:
            raise CubeParseError(f"无法解析的数值 {tok!r}", line_no, source) from exc
        if math.isnan(v) or math.isinf(v):
            raise CubeParseError(f"数值不允许为 NaN/Inf: {tok!r}", line_no, source)
        values.append(v)
    return values


def _read_text(path: str) -> str:
    # 同时兼容带/不带 BOM 的 UTF-8 与 latin-1 老文件。
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- 主入口
def parse_cube(path: str | None = None, text: str | None = None) -> CubeLUT:
    """解析 .cube 文件或文本，返回 :class:`CubeLUT`。

    ``path`` 与 ``text`` 至少给一个；同时给出时以 ``text`` 为内容、
    ``path`` 仅作为来源标注。
    """
    if text is None:
        if path is None:
            raise CubeParseError("需要提供 path 或 text")
        text = _read_text(path)
    source_name = path or "<文本>"

    kind: str | None = None
    size = 0
    title = ""
    domain_min = np.zeros(3, dtype=np.float64)
    domain_max = np.ones(3, dtype=np.float64)
    rows: list[list[float]] = []
    seen_sizes: set[tuple[str, int]] = set()

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        source = raw_line
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        word = line.split(None, 1)[0].upper()
        tokens = line.split()

        if word in KEYWORDS:
            key = word
            rest = tokens[1:]
            if key == "TITLE":
                # TITLE 后通常是带引号的字符串。
                joined = " ".join(rest)
                if len(joined) >= 2 and joined[0] == '"' and joined[-1] == '"':
                    joined = joined[1:-1]
                if not joined:
                    raise CubeParseError("TITLE 缺少标题内容", line_no, source)
                title = joined
                continue

            if key in ("LUT_1D_SIZE", "LUT_3D_SIZE"):
                if len(rest) != 1:
                    raise CubeParseError(f"{key} 后必须只跟一个整数", line_no, source)
                try:
                    n = int(rest[0])
                except ValueError as exc:
                    raise CubeParseError(f"{key} 不是整数: {rest[0]!r}", line_no, source) from exc
                if n < 2:
                    raise CubeParseError(f"{key} 必须 >= 2，实际为 {n}", line_no, source)
                this_kind = "1D" if key == "LUT_1D_SIZE" else "3D"
                if kind is not None:
                    raise CubeParseError(
                        f"重复的尺寸声明（已有 LUT_{kind}_SIZE）", line_no, source
                    )
                kind, size = this_kind, n
                seen_sizes.add((key, line_no))
                continue

            if key in ("DOMAIN_MIN", "DOMAIN_MAX"):
                if len(rest) not in (1, 3):
                    raise CubeParseError(
                        f"{key} 后需要 1 个或 3 个数值", line_no, source
                    )
                vals = _as_float(rest, line_no, source)
                if len(vals) == 1:
                    vals = vals * 3
                arr = np.array(vals, dtype=np.float64)
                if key == "DOMAIN_MIN":
                    domain_min = arr
                else:
                    domain_max = arr
                continue

        # 数据行：必须恰好三个浮点
        if len(tokens) != 3:
            raise CubeParseError(
                f"数据行必须是 3 个数值，实际有 {len(tokens)} 个 token",
                line_no,
                source,
            )
        values = _as_float(tokens, line_no, source)
        rows.append(values)

    if kind is None:
        raise CubeParseError("缺少 LUT_1D_SIZE 或 LUT_3D_SIZE 声明")
    if not rows:
        raise CubeParseError("表中没有任何数据行")

    expected = size if kind == "1D" else size ** 3
    if len(rows) != expected:
        # 帮助定位：指出第一条数据行与实际/期望行数。
        raise CubeParseError(
            f"{kind} LUT 维度/行数对不上：声明 size={size}，"
            f"应有 {expected} 行数据，实际只有 {len(rows)} 行"
            + ("（数据不足）" if len(rows) < expected else "（数据过多）")
        )

    if np.any(domain_max <= domain_min):
        bad = int(np.argmax(domain_max <= domain_min))
        ch = "RGB"[bad]
        raise CubeParseError(
            f"DOMAIN_MAX 必须大于 DOMAIN_MIN（通道 {ch}："
            f"{domain_min[bad]} ~ {domain_max[bad]}）"
        )

    data = np.asarray(rows, dtype=np.float64)
    if kind == "1D":
        table = data.reshape(size, 3)
    else:
        # .cube 3D 排列：R 最慢、G 次之、B 最快。
        table = data.reshape(size, size, size, 3)

    if not np.all(np.isfinite(table)):
        raise CubeParseError("表中存在非有限数值")

    return CubeLUT(
        kind=kind,
        size=size,
        domain_min=domain_min,
        domain_max=domain_max,
        table=table,
        title=title,
        path=source_name,
        metadata={"data_rows": len(rows)},
    )


def write_cube(lut: CubeLUT, path: str) -> None:
    """把 :class:`CubeLUT` 重新写成标准 .cube 文本（便于导出/调试）。"""
    lines: list[str] = []
    if lut.title:
        safe = lut.title.replace('"', "'")
        lines.append(f'TITLE "{safe}"')
    lines.append(
        "DOMAIN_MIN " + " ".join(f"{v:.9g}" for v in lut.domain_min)
    )
    lines.append(
        "DOMAIN_MAX " + " ".join(f"{v:.9g}" for v in lut.domain_max)
    )
    lines.append(f"LUT_{lut.kind}_SIZE {lut.size}")
    flat = lut.table.reshape(-1, 3)
    for r, g, b in flat:
        lines.append(f"{r:.9g} {g:.9g} {b:.9g}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
