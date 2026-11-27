"""fMP4 扫描与建模:把盒子结构翻译成分段/轨道/连续性分析。

术语:
- 分段(fragment):一个 moof(含若干 traf)加它后面的 mdat
- 每段为每个参与的轨道提供一个 traf
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from . import boxes as bx

# 分段状态
FRAG_COMPLETE = "complete"          # moof 与 mdat 都完整
FRAG_BROKEN_MOOF = "broken_moof"    # 断在分段说明(moof)内部
FRAG_BROKEN_MDAT = "broken_mdat"    # moof 完整,断在画面/声音数据(mdat)内部
FRAG_MISSING_MDAT = "missing_mdat"  # moof 完整但后面没有 mdat(文件到此结束)

# 轨道片段的连续性问题
ISSUE_GAP = "gap"          # 序号跳变:中间掉了段
ISSUE_DUPLICATE = "duplicate"  # 序号倒退/重复
ISSUE_UNORDERED = "unordered"  # 序号非递增但不属重复
ISSUE_OK = "ok"


@dataclass
class TrackMeta:
    track_id: int
    kind: str                 # video / audio / ...
    timescale: int
    handler: str
    width: float | None = None
    height: float | None = None
    default_sample_duration: int = 0
    default_sample_size: int = 0


@dataclass
class TrackRun:
    """一个分段内某条轨道的 traf 信息。"""

    track_id: int
    tfdt: int                       # 段内相对解码时间(timescale 单位)
    sample_count: int
    sample_sizes: list[int]         # trun 给出的样本字节大小
    sample_durations: list[int]     # trun/trex 推出的样本时长
    span_media_time: int            # 本段覆盖的媒体时间长度(timescale 单位)
    declared_data_size: int         # trun 声明本轨道需要的 mdat 字节数
    # 按分段顺序累计出的全局时间轴(tfdt 每段重置,不能直接当播放时间)
    cumulative_start: int = 0
    cumulative_end: int = 0
    issue: str = ISSUE_OK
    issue_detail: str = ""


@dataclass
class Fragment:
    index: int                  # 文件中第几个分段(从 1 开始,含坏段)
    moof_offset: int
    sequence_number: int | None  # mfhd 序号;moof 截断时可能拿不到
    status: str
    runs: list[TrackRun] = field(default_factory=list)
    # 数据范围
    moof_size: int = 0
    mdat_offset: int | None = None
    mdat_size: int | None = None          # 声明大小(截断时为期望值)
    mdat_available: int | None = None     # 实际可读字节
    end_offset: int = 0                   # 该分段占据的文件范围终点
    parse_note: str = ""                  # moof 截断时说明断在哪个子盒子附近


@dataclass
class TrackTimeline:
    """一条轨道跨分段的累计时间线。"""

    track_id: int
    kind: str
    timescale: int
    # 每段: (fragment_index, sequence_number, span_media_time, issue, detail)
    entries: list[tuple[int, int, int, str, str]] = field(default_factory=list)
    total_span_media_time: int = 0       # 所有段(含问题段)span 之和
    prefix_span_media_time: int = 0      # 落在全局连续前缀内的 span 之和
    issues: list[str] = field(default_factory=list)

    @property
    def total_seconds(self) -> float:
        return self.total_span_media_time / self.timescale if self.timescale else 0.0

    @property
    def prefix_seconds(self) -> float:
        return self.prefix_span_media_time / self.timescale if self.timescale else 0.0


@dataclass
class ScanResult:
    path: str
    file_size: int
    readable: bool = True
    reject_reason: str = ""           # 起始说明缺失等致命问题
    ftyp_present: bool = False
    is_fragmented: bool = False
    tracks: dict[int, TrackMeta] = field(default_factory=dict)
    fragments: list[Fragment] = field(default_factory=list)
    timelines: dict[int, TrackTimeline] = field(default_factory=dict)
    trailing_bytes: int = 0
    # 连续前缀:可安全导出的文件字节范围 [0, export_cut_offset)
    export_cut_offset: int = 0
    export_fragment_count: int = 0
    has_issues: bool = False

    def track_kind(self, track_id: int) -> str:
        meta = self.tracks.get(track_id)
        return meta.kind if meta else f"track{track_id}"


def _parse_moov(moov: bx.Box) -> tuple[dict[int, TrackMeta], bool]:
    tracks: dict[int, TrackMeta] = {}
    for trak in moov.find_all(b"trak"):
        mdia = trak.find(b"mdia")
        if mdia is None:
            continue
        mdhd = mdia.find(b"mdhd")
        hdlr = mdia.find(b"hdlr")
        tkhd = trak.find(b"tkhd")
        if mdhd is None or hdlr is None or tkhd is None:
            continue
        md = bx.parse_mdhd(mdhd)
        kind = bx.parse_hdlr(hdlr)
        th = bx.parse_tkhd(tkhd)
        meta = TrackMeta(
            track_id=th.track_id,
            kind=kind,
            timescale=md.timescale,
            handler=kind,
            width=th.width if kind == "video" else None,
            height=th.height if kind == "video" else None,
        )
        tracks[meta.track_id] = meta

    mvex = moov.find(b"mvex")
    is_fragmented = mvex is not None
    if mvex is not None:
        for trex_box in mvex.find_all(b"trex"):
            trex = bx.parse_trex(trex_box)
            if trex.track_id in tracks:
                tracks[trex.track_id].default_sample_duration = trex.default_sample_duration
                tracks[trex.track_id].default_sample_size = trex.default_sample_size
    return tracks, is_fragmented


def _parse_traf(traf: bx.Box, meta: TrackMeta | None) -> TrackRun:
    tfhd_box = traf.find(b"tfhd")
    if tfhd_box is None:
        raise bx.BoxError("traf 缺少 tfhd")
    tfhd = bx.parse_tfhd(tfhd_box)

    tfdt_box = traf.find(b"tfdt")
    tfdt_value = bx.parse_tfdt(tfdt_box).base_media_decode_time if tfdt_box else 0

    trun_box = traf.find(b"trun")
    if trun_box is not None:
        trun = bx.parse_trun(trun_box)
        default_dur = tfhd.default_sample_duration
        if default_dur is None and meta is not None:
            default_dur = meta.default_sample_duration
        default_size = tfhd.default_sample_size
        if default_size is None and meta is not None:
            default_size = meta.default_sample_size
        durations: list[int] = []
        sizes: list[int] = []
        for sample in trun.samples:
            durations.append(sample.duration if sample.duration is not None else (default_dur or 0))
            sizes.append(sample.size if sample.size is not None else (default_size or 0))
    else:
        durations, sizes = [], []

    return TrackRun(
        track_id=tfhd.track_id,
        tfdt=tfdt_value,
        sample_count=len(sizes),
        sample_sizes=sizes,
        sample_durations=durations,
        span_media_time=sum(durations),
        declared_data_size=sum(sizes),
    )


def _parse_moof_fragment(
    moof: bx.Box,
    tracks: dict[int, TrackMeta],
    index: int,
) -> Fragment:
    mfhd = moof.find(b"mfhd")
    seq = bx.parse_mfhd(mfhd).sequence_number if mfhd else None
    frag = Fragment(
        index=index,
        moof_offset=moof.offset,
        sequence_number=seq,
        status=FRAG_COMPLETE,
        moof_size=moof.size,
        end_offset=moof.end,
    )
    for traf in moof.find_all(b"traf"):
        tfhd_box = traf.find(b"tfhd")
        if tfhd_box is None:
            continue
        meta = tracks.get(bx.parse_tfhd(tfhd_box).track_id)
        frag.runs.append(_parse_traf(traf, meta))
    return frag


def scan(data: bytes, path: str) -> ScanResult:
    """扫描一段 fMP4 字节,返回结构化结果。任何损坏都不抛异常。"""
    result = ScanResult(path=path, file_size=len(data))
    try:
        top = bx.parse_top_level(data)
    except bx.BoxError as exc:
        result.readable = False
        result.reject_reason = f"盒子结构无法解析: {exc}"
        return result

    result.ftyp_present = any(b.type == b"ftyp" for b in top.boxes)
    moov = next((b for b in top.boxes if b.type == b"moov"), None)
    if moov is None:
        result.readable = False
        result.reject_reason = (
            "起始说明盒子 moov 缺失(或自身被截断),无法知道轨道与编码配置,拒绝修复"
        )
        return result

    tracks, is_frag = _parse_moov(moov)
    result.tracks = tracks
    result.is_fragmented = is_frag
    if not is_frag:
        result.readable = False
        result.reject_reason = "moov 中没有 mvex,不是分段 MP4,不在本工具抢救范围内"
        return result
    result.trailing_bytes = top.trailing_bytes

    # 顶层盒子按顺序配对 moof/mdat
    index = 0
    pending_moof: Fragment | None = None
    for box in top.boxes:
        if box.type == b"moof":
            if pending_moof is not None:
                # 上一个 moof 没等到 mdat
                pending_moof.status = FRAG_MISSING_MDAT
                pending_moof.parse_note = "moof 之后没有配套 mdat 就遇到了下一个盒子"
                result.fragments.append(pending_moof)
            index += 1
            pending_moof = _parse_moof_fragment(box, tracks, index)
        elif box.type == b"mdat" and pending_moof is not None:
            pending_moof.mdat_offset = box.offset
            pending_moof.mdat_size = box.size
            pending_moof.mdat_available = box.size - box.header_size
            pending_moof.end_offset = box.end
            result.fragments.append(pending_moof)
            pending_moof = None
        # 其它顶层盒子(ftyp/mfra/udta 等)在此忽略

    # 截断的尾部盒子
    trunc = top.truncated
    if trunc is not None:
        if trunc.type == b"moof":
            index += 1
            frag = Fragment(
                index=index,
                moof_offset=trunc.offset,
                sequence_number=None,
                status=FRAG_BROKEN_MOOF,
                moof_size=trunc.declared_size,
                end_offset=len(data),
                parse_note=_describe_broken_moof(data, trunc),
            )
            # 尽力从残片中读出 traf(可能缺 tfhd/trun)
            _salvage_broken_moof(data, trunc, tracks, frag)
            result.fragments.append(frag)
        elif trunc.type == b"mdat" and pending_moof is not None:
            pending_moof.status = FRAG_BROKEN_MDAT
            pending_moof.mdat_offset = trunc.offset
            pending_moof.mdat_size = trunc.declared_size
            pending_moof.mdat_available = len(trunc.available_payload)
            pending_moof.end_offset = len(data)
            result.fragments.append(pending_moof)
            pending_moof = None
        else:
            # 其它盒子截断(如 mfra),不影响分段数据
            if pending_moof is not None:
                pending_moof.status = FRAG_MISSING_MDAT
                result.fragments.append(pending_moof)
                pending_moof = None
    if pending_moof is not None:
        pending_moof.status = FRAG_MISSING_MDAT
        pending_moof.parse_note = "文件在 moof 之后结束,配套 mdat 完全没写"
        result.fragments.append(pending_moof)

    _build_timelines(result)
    _compute_export_prefix(result, moov)
    result.has_issues = any(t.issues for t in result.timelines.values()) or any(
        f.status != FRAG_COMPLETE for f in result.fragments
    )
    return result


def _describe_broken_moof(data: bytes, trunc: bx.TruncatedBox) -> str:
    """判断 moof 残片里已经写到哪个子盒子。"""
    payload_start = trunc.offset + trunc.header_size
    try:
        children = bx._iter_boxes(data, payload_start, len(data))
    except bx.BoxError:
        return "moof 头部损坏,子盒子无法遍历"
    seen = [c.type.decode("latin1") for c in children]
    if not seen:
        return "moof 盒子头刚写完,内部子盒子(mfhd/traf)全部缺失"
    last = seen[-1]
    if isinstance(children[-1], bx.TruncatedBox):
        return f"断在 moof 内部的 {last} 盒子里;已写完的子盒子: {', '.join(seen[:-1]) or '无'}"
    return f"moof 在 {last} 之后被截断,缺少后续 traf/mdat"


def _salvage_broken_moof(
    data: bytes,
    trunc: bx.TruncatedBox,
    tracks: dict[int, TrackMeta],
    frag: Fragment,
) -> None:
    payload_start = trunc.offset + trunc.header_size
    try:
        children = bx._iter_boxes(data, payload_start, len(data))
    except bx.BoxError:
        return
    for child in children:
        if not isinstance(child, bx.Box) or child.type != b"traf":
            continue
        try:
            tfhd_box = child.find(b"tfhd")
            if tfhd_box is None:
                continue
            tfhd = bx.parse_tfhd(tfhd_box)
            meta = tracks.get(tfhd.track_id)
            frag.runs.append(_parse_traf(child, meta))
        except (bx.BoxError, struct.error):
            continue


def _build_timelines(result: ScanResult) -> None:
    """汇总每条轨道的时间线,并按全局 mfhd 序号判断掉段/重复段。

    序号是 moof 级别的(一个 moof 可含多条轨道的 traf),因此连续性
    以分段序列为准;某条轨道合法缺席个别分段(如末段只有音频)不算问题。
    """
    tls: dict[int, TrackTimeline] = {}
    for tid, meta in result.tracks.items():
        tls[tid] = TrackTimeline(track_id=tid, kind=meta.kind, timescale=meta.timescale)

    prev_seq: int | None = None
    for frag in result.fragments:
        seq = frag.sequence_number
        global_issue, global_detail = ISSUE_OK, ""
        if seq is not None and prev_seq is not None:
            if seq == prev_seq:
                global_issue, global_detail = ISSUE_DUPLICATE, f"mfhd 序号 {seq} 与上一段重复"
            elif seq < prev_seq:
                global_issue, global_detail = ISSUE_UNORDERED, f"mfhd 序号从 {prev_seq} 倒退到 {seq}"
            elif seq > prev_seq + 1:
                global_issue, global_detail = ISSUE_GAP, (
                    f"mfhd 序号从 {prev_seq} 跳到 {seq},中间缺 {seq - prev_seq - 1} 段"
                )
        if seq is not None:
            prev_seq = seq

        for run in frag.runs:
            tl = tls.get(run.track_id)
            if tl is None:
                meta = result.tracks.get(run.track_id)
                tl = TrackTimeline(
                    track_id=run.track_id,
                    kind=meta.kind if meta else "unknown",
                    timescale=meta.timescale if meta else 1,
                )
                tls[run.track_id] = tl
            issue, detail = global_issue, global_detail
            if issue != ISSUE_OK:
                run.issue = issue
                run.issue_detail = detail
                tl.issues.append(f"分段 {frag.index}(序号 {seq}): {detail}")
            # 累计全局时间:该轨道此前所有 traf 的 span 之和
            run.cumulative_start = tl.total_span_media_time
            run.cumulative_end = tl.total_span_media_time + run.span_media_time
            tl.entries.append((frag.index, seq or -1, run.span_media_time, issue, detail))
            tl.total_span_media_time += run.span_media_time
    result.timelines = tls


def _compute_export_prefix(result: ScanResult, moov: bx.Box) -> None:
    """确定可安全导出的字节前缀。

    规则(全局,从第一段开始逐条检查,遇任何违规即停):
    1. 分段必须完整(moof+mdat 都在);
    2. mfhd 序号必须从 1 开始严格 +1(掉段、重复段、乱序都截断在该处之前)。

    轨道缺席某分段(如末段只有音频)是合法的,不影响前缀判定。
    """
    last_good = 0
    cut = moov.end
    expected_seq = 1
    for frag in result.fragments:
        if frag.status != FRAG_COMPLETE:
            break
        if frag.sequence_number != expected_seq:
            break
        last_good = frag.index
        cut = frag.end_offset
        expected_seq += 1

    result.export_fragment_count = last_good
    result.export_cut_offset = cut
    for tl in result.timelines.values():
        for frag_index, _seq, span, _issue, _detail in tl.entries:
            if frag_index <= last_good:
                tl.prefix_span_media_time += span
