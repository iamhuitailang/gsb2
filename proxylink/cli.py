"""proxylink 命令行入口。

运行 ``python -m proxylink.cli -h`` 查看全部命令。
"""

import argparse
import json
import os
import sys

from .errors import ProxyLinkError
from .gen_media import DEFAULT_DURATION, DEFAULT_FPS, generate_all, generate_and_register
from .media import verify_candidate
from .project import Project
from .timecode import format_clock, format_smpte


# ---------------- 输出辅助 ----------------

def _ok(msg):
    print(f"✓ {msg}")


def _warn(msg):
    print(f"⚠ {msg}")


def _err(msg):
    print(f"✗ {msg}", file=sys.stderr)


def _print_media_row(m):
    flag = "" if m.exists else "  [文件丢失]"
    print(f"  {m.id}")
    print(f"    文件: {m.filename}{flag}  分辨率: {m.resolution}  "
          f"时长: {format_clock(m.duration)}  fps: {m.fps:g}  编码: {m.codec}")


def _print_detail(d):
    print(f"ID:       {d['id']}")
    print(f"路径:     {d['path']}" + ("" if d["exists"] else "  [文件丢失]"))
    print(f"容器:     {d['container']}  大小: {d['size_bytes']} 字节")
    print(f"时长:     {format_clock(d['duration'])} ({d['duration']:.3f}s)")
    print(f"分辨率:   {d['resolution']}  帧率: {d['fps']:g} fps  "
          f"帧数: {d['nb_frames']}")
    print(f"签名:     sha256(首+尾)={d['partial_sha256'][:16]}…")
    print("视频流:")
    for s in d["video_streams"]:
        print(f"  #{s['index']} {s['codec']} {s.get('profile') or ''} "
              f"{s['width']}x{s['height']} {s['fps']:g}fps "
              f"pix_fmt={s.get('pix_fmt')} frames={s.get('nb_frames')}")
    if d["audio_streams"]:
        print("音频流:")
        for s in d["audio_streams"]:
            print(f"  #{s['index']} {s['codec']} {s.get('channels')}ch "
                f"{s.get('sample_rate')}Hz")
    else:
        print("音频流:   无")
    if d["same_filename_others"]:
        _warn("存在同文件名但不同目录的登记记录（视为不同素材）:")
        for p in d["same_filename_others"]:
            print(f"    - {p}")
    for lk in d["links"]:
        print(f"挂接: {lk['link_id']}（角色: {lk['role']}）")


def _print_coverage(status):
    cov = status["coverage"]
    o, p = status["original"], status["proxy"]
    print(f"挂接 {status['link_id']}：{o['filename']}  ↔  {p['filename']}")
    print(f"走时比 rate={cov['rate']:.6f}（标定 "
          f"{len(status['calibration']['anchors'])} 点）")
    for a in status["calibration"]["anchors"]:
        print(f"  锚点: 原片 {a['original']:.3f}s ↔ 代理 {a['proxy']:.3f}s")

    head = cov["head_match"]
    tail = cov["tail_match"]
    print("\n首尾匹配:")
    if head["aligned"]:
        print("  首部: 代理首帧与原片首帧对齐")
    else:
        _warn(f"首部: 代理起点偏移 —— 代理首帧对应原片 "
              f"{head['proxy_first_frame_original_t']:.3f}s，"
              f"原片前 {head['original_missing_head_seconds']:.3f}s "
              f"({head['original_missing_head_frames']} 帧) 在代理中不存在")
    if tail["aligned"]:
        print("  尾部: 代理末帧与原片末帧对齐")
    else:
        _warn(f"尾部: 代理缺尾 —— 代理末帧只到原片 "
              f"{tail['proxy_last_frame_original_t']:.3f}s，"
              f"原片最后 {tail['original_missing_tail_seconds']:.3f}s "
              f"({tail['original_missing_tail_frames']} 帧) 无法可靠定位")

    rel = cov["original"]["reliable_range"]
    print(f"\n原片可靠区间: {rel[0]:.3f}s – {rel[1]:.3f}s "
          f"（共 {rel[1] - rel[0]:.3f}s / 总长 {cov['original']['duration']:.3f}s）")
    for u in cov["original"]["unreachable"]:
        if u["seconds"] > 1e-6:
            _warn(f"  不可定位区间（{u['side']}）: "
                  f"{u['range'][0]:.3f}s – {u['range'][1]:.3f}s，"
                  f"{u['seconds']:.3f}s / {u['frames']} 帧")
    print(f"代理覆盖区间: {cov['proxy']['reliable_range'][0]:.3f}s – "
          f"{cov['proxy']['reliable_range'][1]:.3f}s（全段 {cov['proxy']['duration']:.3f}s）")


# ---------------- 各命令 ----------------

def cmd_register(args, proj):
    media = proj.register(args.path)
    _ok(f"已登记 {media.filename}（{media.resolution}, {media.duration:.3f}s, "
        f"{media.fps:g}fps, id={media.id}）")


def cmd_media(args, proj):
    if args.media_action == "list":
        media = proj.list_media()
        if not media:
            print("素材库为空")
            return
        print(f"共 {len(media)} 条素材:")
        for m in media:
            _print_media_row(m)
    else:
        _print_detail(proj.media_detail(args.ref))


def cmd_link(args, proj):
    link = proj.create_link(args.original, args.proxy, label=args.label or "")
    _ok(f"已建立挂接 {link.id}")
    print("下一步: calibrate 命令标定对应时间点")


def cmd_links(args, proj):
    if not proj.state.links:
        print("暂无挂接，可用 link 命令建立")
        return
    for lk in proj.state.links.values():
        o = proj.state.get_media(lk.original_id)
        p = proj.state.get_media(lk.proxy_id)
        state = "已标定" if lk.calibration.get("anchors") else "未标定"
        print(f"  {lk.id}  [{state}] {lk.label or ''}")
        print(f"      原片: {o.path}")
        print(f"      代理: {p.path}")


def cmd_calibrate(args, proj):
    pairs = []
    for spec in args.anchor:
        if "=" not in spec:
            raise ProxyLinkError(f"锚点格式应为 原片时间=代理时间: {spec!r}")
        o, p = spec.split("=", 1)
        pairs.append((o.strip(), p.strip()))
    mapping = proj.calibrate(args.link_id, pairs)
    _ok(f"标定完成，rate={mapping.rate:.6f}，共 {len(mapping.anchors)} 个锚点")


def cmd_status(args, proj):
    _print_coverage(proj.link_status(args.link_id))


def cmd_locate(args, proj):
    result = proj.locate(args.link_id, args.side, args.time)
    if not result["ok"]:
        _err("无法定位 —— " + result["reason"])
        sys.exit(2)
    _ok(f"对应画面: {result['mapped']:.3f}s "
        f"（帧 {result.get('target_frame')}，目标时长 {result['target_duration']:.3f}s）")


def cmd_cut(args, proj):
    if args.cut_action == "add":
        cp = proj.add_cut_point(args.link_id, args.time, side=args.side,
                                label=args.label or "")
        orig = proj.state.get_media(cp.source["original_id"])
        tail = "" if cp.reliable else f"  ⚠ {cp.note}"
        _ok(f"剪辑点 {cp.id}: 原片 {format_smpte(cp.original_time, orig.fps)}"
            f" <- 代理 {cp.proxy_time:.3f}s{tail}")
    elif args.cut_action == "rm":
        proj.remove_cut_point(args.cut_id)
        _ok(f"已删除剪辑点 {args.cut_id}")
    else:
        points = proj.list_cut_points()
        if not points:
            print("暂无剪辑点")
            return
        print(f"共 {len(points)} 个剪辑点:")
        for c in points:
            src = c.source
            mark = "✓" if c.reliable else "⚠"
            print(f"  {mark} {c.id} [{c.label or ''}] 原片 {c.original_time:7.3f}s "
                  f"<- 代理 {src['proxy_filename']}@{c.proxy_time:.3f}s"
                  + (f"  ({c.note})" if c.note else ""))


def cmd_session(args, proj):
    if args.session_action == "seek":
        view = proj.seek(args.link_id, args.time, side=args.side)
    elif args.session_action == "switch":
        view = proj.switch_side(clamp=args.clamp)
        if view["stopped"]:
            _print_session(view)
            sys.exit(2)
    elif args.session_action == "tick":
        view = proj.tick(args.seconds)
        if view["stopped"]:
            _print_session(view)
            sys.exit(2)
    elif args.session_action == "stop":
        proj.stop()
        view = proj.session_view()
    else:
        view = proj.session_view()
        if view is None:
            print("暂无播放会话")
            return
    _print_session(view)


def _print_session(view):
    print(f"挂接 {view['link_id']}  当前侧: {'原片' if view['side'] == 'original' else '代理'}")
    print(f"  原片: {view['original']['timecode']} ({view['original']['time']:.3f}s, "
          f"帧 {view['original']['frame']}) / 时长 {view['original']['duration']:.3f}s")
    print(f"  代理: {view['proxy']['timecode']} ({view['proxy']['time']:.3f}s, "
          f"帧 {view['proxy']['frame']}) / 时长 {view['proxy']['duration']:.3f}s")
    rel = view["reliable_original_range"]
    print(f"  原片可靠区间: {rel[0]:.3f}s – {rel[1]:.3f}s")
    if view["stopped"]:
        _err(f"已停止: {view['stop_reason']}")


def cmd_check(args, proj):
    rows = proj.check_files()
    missing = [r for r in rows if not r["exists"]]
    for r in rows:
        print(f"{'✓' if r['exists'] else '✗'} {r['path']}")
    if missing:
        _warn(f"{len(missing)} 个文件丢失，可用 relink find/relink 重新挂接")


def cmd_relink(args, proj):
    if args.relink_action == "find":
        reports = proj.find_relink_candidates(args.ref, args.dir)
        if not reports:
            _warn(f"在 {args.dir} 下未找到同名文件 {os.path.basename(args.ref)}")
            return
        for rep in reports:
            symbol = "✓" if rep["verdict"] == "match" else "✗"
            print(f"{symbol} {rep['path']}  ({rep['matched']}/{rep['total']} 项特征匹配)")
            for c in rep["checks"]:
                if not c["ok"]:
                    print(f"    ✗ {c['field']}: 期望 {c['expected']!r}，实际 {c['actual']!r}")
    else:
        result = proj.relink(args.ref, args.new_path, force=args.force)
        _ok(f"已重新挂接到 {result['media'].path}")
        if result.get("forced"):
            _warn("使用了 --force，特征并不完全匹配，请人工确认！")
            for c in result["report"]["checks"]:
                if not c["ok"]:
                    print(f"    ✗ {c['field']}: 期望 {c['expected']!r}，实际 {c['actual']!r}")


def cmd_export(args, proj):
    text = proj.export_cut_points(fmt=args.format, link_id=args.link_id)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        _ok(f"已导出 {len(proj.list_cut_points(args.link_id))} 个剪辑点到 {args.output}")
    else:
        print(text)


def cmd_gen(args, proj):
    if args.register:
        result = generate_and_register(args.dir, base_dir=proj.store.base_dir,
                                       duration=args.duration, fps=args.fps)
        _ok(f"已生成并登记 {len(result['paths'])} 个素材到 {os.path.abspath(args.dir)}")
        for key, path in result["paths"].items():
            print(f"  {key}: {path}")
        for key, lk in result["links"].items():
            print(f"  挂接 {key}: {lk.id}")
    else:
        paths = generate_all(args.dir, duration=args.duration, fps=args.fps)
        _ok(f"已生成 {len(paths)} 个素材到 {os.path.abspath(args.dir)}:")
        for key, path in paths.items():
            print(f"  {key}: {path}")


def cmd_serve(args, proj):
    from .webui import run_server
    run_server(proj.store.base_dir, host=args.host, port=args.port)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="proxylink",
        description="本地代理素材挂接与时间位置校验工具",
    )
    parser.add_argument("-C", "--base-dir", default=".", help="项目目录（状态存于其 .proxylink 下）")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("register", help="登记素材并探测分辨率/时长/视频流").add_argument("path")

    p_media = sub.add_parser("media", help="查看素材")
    ms = p_media.add_subparsers(dest="media_action", required=True)
    ms.add_parser("list", help="列出全部素材")
    m_show = ms.add_parser("show", help="查看素材详情（可用 id/路径/文件名）")
    m_show.add_argument("ref")

    p_link = sub.add_parser("link", help="建立原片-代理挂接")
    p_link.add_argument("original")
    p_link.add_argument("proxy")
    p_link.add_argument("--label", default="")

    sub.add_parser("links", help="列出全部挂接及其 id/标定状态")

    p_cal = sub.add_parser("calibrate", help="标定对应时间点，1 或 2 个 --anchor")
    p_cal.add_argument("link_id")
    p_cal.add_argument("--anchor", action="append", required=True,
                       help="格式 原片时间=代理时间，如 2.0=0.0 或 00:00:02:00=00:00:00:00")

    p_status = sub.add_parser("status", help="查看挂接的可靠区间与首尾匹配")
    p_status.add_argument("link_id")

    p_loc = sub.add_parser("locate", help="换算并检查某个时间点能否可靠定位")
    p_loc.add_argument("link_id")
    p_loc.add_argument("--side", choices=["original", "proxy"], default="original")
    p_loc.add_argument("time")

    p_cut = sub.add_parser("cut", help="剪辑点管理")
    cs = p_cut.add_subparsers(dest="cut_action", required=True)
    c_add = cs.add_parser("add", help="添加剪辑点")
    c_add.add_argument("link_id")
    c_add.add_argument("time")
    c_add.add_argument("--side", choices=["original", "proxy"], default="original")
    c_add.add_argument("--label", default="")
    c_rm = cs.add_parser("rm", help="删除剪辑点")
    c_rm.add_argument("cut_id")
    cs.add_parser("list", help="列出剪辑点及溯源摘要")

    p_ses = sub.add_parser("session", help="播放头：切换原片/代理保持同一画面")
    ss = p_ses.add_subparsers(dest="session_action", required=True)
    s_seek = ss.add_parser("seek", help="定位播放头")
    s_seek.add_argument("link_id")
    s_seek.add_argument("time")
    s_seek.add_argument("--side", choices=["original", "proxy"], default="original")
    s_switch = ss.add_parser("switch", help="切换原片/代理，越界即停止")
    s_switch.add_argument("--clamp", action="store_true", help="越界时夹到边界而非停止")
    s_tick = ss.add_parser("tick", help="播放推进 N 秒（负数后退）")
    s_tick.add_argument("seconds", type=float)
    ss.add_parser("stop", help="手动停止")
    ss.add_parser("show", help="查看当前播放头")

    sub.add_parser("check", help="检查已登记文件是否仍在原位")

    p_relink = sub.add_parser("relink", help="文件移动后重新挂接")
    rs = p_relink.add_subparsers(dest="relink_action", required=True)
    r_find = rs.add_parser("find", help="在新目录递归找同名候选并比对特征")
    r_find.add_argument("ref")
    r_find.add_argument("dir")
    r_do = rs.add_parser("do", help="执行重新挂接，特征不符默认拒绝")
    r_do.add_argument("ref")
    r_do.add_argument("new_path")
    r_do.add_argument("--force", action="store_true", help="特征不符也强制挂接")

    p_exp = sub.add_parser("export", help="导出原片时间位置剪辑点清单（含溯源）")
    p_exp.add_argument("--format", choices=["json", "csv", "md"], default="json")
    p_exp.add_argument("--link", dest="link_id", default=None)
    p_exp.add_argument("--output", "-o", default=None)

    p_gen = sub.add_parser("gen", help="生成带画面计数标记的测试素材")
    p_gen.add_argument("dir")
    p_gen.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    p_gen.add_argument("--fps", type=float, default=DEFAULT_FPS)
    p_gen.add_argument("--register", action="store_true", help="生成后自动登记/挂接/标定")

    p_serve = sub.add_parser("serve", help="启动本地 Web 界面")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8321)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    proj = Project(args.base_dir)
    handlers = {
        "register": cmd_register,
        "media": cmd_media,
        "link": cmd_link,
        "links": cmd_links,
        "calibrate": cmd_calibrate,
        "status": cmd_status,
        "locate": cmd_locate,
        "cut": cmd_cut,
        "session": cmd_session,
        "check": cmd_check,
        "relink": cmd_relink,
        "export": cmd_export,
        "gen": cmd_gen,
        "serve": cmd_serve,
    }
    try:
        handlers[args.command](args, proj)
    except ProxyLinkError as exc:
        _err(str(exc))
        if hasattr(exc, "details") and exc.details:
            for c in exc.details:
                print(f"    ✗ {c['field']}: 期望 {c['expected']!r}，实际 {c['actual']!r}",
                      file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError as exc:
        _err(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
