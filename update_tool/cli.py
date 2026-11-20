"""命令行入口。

用法：python -m update_tool [--root DIR] <命令> ...
--root 默认取环境变量 UPDATE_TOOL_ROOT，否则 ./updtool_state。
所有状态都只写在 --root 之下。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from . import TOOL_VERSION, keys as keystore, manifest as mf, package as pkg
from .errors import ToolError
from .store import Store


def _check_name(value, what):
    try:
        return mf.check_name(value, what)
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(str(e))


def cmd_keygen(args, root: Path) -> int:
    kid = keystore.generate_and_save(
        root, bits=args.bits, label=args.name, trust=not args.no_trust
    )
    print(f"已生成演示密钥 {kid}")
    print(f"  私钥: {root / 'keys' / 'private' / (kid + '.json')}（权限 600，勿外传）")
    print(f"  公钥: {root / 'keys' / 'public' / (kid + '.json')}")
    print("  信任状态: " + ("已加入受信列表" if not args.no_trust else "未受信（--no-trust）"))
    return 0


def cmd_trust_list(args, root: Path) -> int:
    entries = keystore.TrustStore(root).list()
    if not entries:
        print("受信列表为空")
        return 0
    for kid, e in sorted(entries.items()):
        label = f" ({e['label']})" if e.get("label") else ""
        print(f"{kid}  {e['status']}{label}  added={e.get('added', '-')}")
    return 0


def cmd_trust_add(args, root: Path) -> int:
    pub = keystore.load_public_file(args.pubkey_file)
    kid = keystore.TrustStore(root).add(pub, label=args.name)
    print(f"已把公钥 {kid} 加入受信列表（active）")
    return 0


def cmd_trust_revoke(args, root: Path) -> int:
    keystore.TrustStore(root).revoke(args.key_id)
    Store(root).log("trust-revoke", "-", "-", "-", True, f"revoked key {args.key_id}")
    print(f"已撤销钥匙 {args.key_id}；此后由它签发的包一律拒绝")
    return 0


def cmd_pack(args, root: Path) -> int:
    mf.check_name(args.product, "产品名")
    mf.check_name(args.channel, "通道名")
    mf.version_tuple(args.version)
    mf.version_tuple(args.min_tool_version)
    if args.key_file:
        rec = json.loads(Path(args.key_file).read_text(encoding="utf-8"))
        priv = dict(rec["public"])
        priv["d"] = rec["private"]["d"]
        from . import crypto
        key_id = crypto.key_id(rec["public"])
    else:
        key_id = args.key_id
        priv = keystore.load_private(root, key_id)
    out = pkg.pack(args.content, args.product, args.channel, args.version,
                   args.min_tool_version, key_id, priv, args.out)
    print(f"已生成更新包: {out}")
    print(f"  {args.product}/{args.channel} 版本 {args.version}，签发钥匙 {key_id}")
    return 0


def _verify(pkg_path, root: Path, dest_dir) -> dict:
    trust = keystore.TrustStore(root)
    return pkg.verify_package(pkg_path, trust, dest_dir)


def cmd_inspect(args, root: Path) -> int:
    with tempfile.TemporaryDirectory(prefix="upd-inspect-") as tmp:
        info = _verify(args.package, root, Path(tmp) / "payload")
    print(f"验收通过: {args.package}")
    print(f"  产品/通道/版本: {info['product']}/{info['channel']}/{info['version']}")
    print(f"  最低工具版本: {info['min_tool_version']}（当前工具 {TOOL_VERSION}）")
    print(f"  签发钥匙: {info['key_id']}（受信且未撤销）")
    print(f"  文件数: {len(info['files'])}，归档结构与摘要核对全部通过")
    print("结果: ACCEPTED")
    return 0


def cmd_trial_install(args, root: Path) -> int:
    store = Store(root)
    tmp_parent = root / "tmp"
    tmp_parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="incoming-", dir=tmp_parent))
    try:
        payload = work / "payload"
        info = _verify(args.package, root, payload)
        store.trial_install(info, payload)
    except ToolError as e:
        # 失败也留一条可读记录（不含任何密钥材料）
        store.log("trial-install", "-", "-", "-", False, str(e))
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"试装就绪: {info['product']}/{info['channel']} 版本 {info['version']}")
    print("内容在隔离的 staging 目录，当前生效版本未受影响。")
    print(f"确认无误后执行: activate --product {info['product']} --channel {info['channel']}")
    return 0


def cmd_activate(args, root: Path) -> int:
    store = Store(root)
    try:
        version = store.activate(args.product, args.channel)
    except ToolError as e:
        store.log("activate", args.product, args.channel, "-", False, str(e))
        raise
    print(f"已激活 {args.product}/{args.channel} 版本 {version}")
    return 0


def cmd_rollback(args, root: Path) -> int:
    store = Store(root)
    version = store.rollback(args.product, args.channel)
    print(f"已回滚 {args.product}/{args.channel} 到版本 {version}")
    return 0


def cmd_discard_staged(args, root: Path) -> int:
    store = Store(root)
    staged = store.discard_staged(args.product, args.channel)
    if staged:
        print(f"已丢弃试装中的版本 {staged['version']}")
    else:
        print("没有试装中的版本")
    return 0


def cmd_status(args, root: Path) -> int:
    states = Store(root).status(product=args.product, channel=args.channel)
    if not states:
        print("（没有任何安装记录）")
        return 0
    for s in states:
        print(f"{s['product']}/{s['channel']}")
        print(f"  当前版本: {s['current'] or '（无）'}")
        print(f"  激活历史: {', '.join(s['history']) or '（无）'}")
        staged = s.get("staged")
        print(f"  试装中:   {staged['version'] if staged else '（无）'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="update_tool",
        description="本地软件更新包验收工具（纯离线演示，只操作 --root 目录）",
    )
    p.add_argument("--root", default=os.environ.get("UPDATE_TOOL_ROOT", "updtool_state"),
                   help="工具的演示状态目录（默认 ./updtool_state 或 $UPDATE_TOOL_ROOT）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("keygen", help="生成本地演示用的签名密钥对")
    sp.add_argument("--name", default="", help="钥匙的备注名")
    sp.add_argument("--bits", type=int, default=2048, help="演示 RSA 位数（默认 2048）")
    sp.add_argument("--no-trust", action="store_true", help="只生成，不加入受信列表")
    sp.set_defaults(func=cmd_keygen)

    sp = sub.add_parser("trust-list", help="查看受信公钥列表")
    sp.set_defaults(func=cmd_trust_list)

    sp = sub.add_parser("trust-add", help="把一把公钥加入受信列表（新增下一把钥匙）")
    sp.add_argument("pubkey_file")
    sp.add_argument("--name", default="")
    sp.set_defaults(func=cmd_trust_add)

    sp = sub.add_parser("trust-revoke", help="撤销一把钥匙（此后它签发的包一律拒绝）")
    sp.add_argument("key_id")
    sp.set_defaults(func=cmd_trust_revoke)

    sp = sub.add_parser("pack", help="把内容目录打包成带签名的更新包")
    sp.add_argument("--content", required=True, help="要打包的内容目录")
    sp.add_argument("--product", required=True)
    sp.add_argument("--channel", required=True)
    sp.add_argument("--version", required=True)
    sp.add_argument("--min-tool-version", default="1.0.0", dest="min_tool_version")
    sp.add_argument("--key-id", help="用 --root 下哪把私钥签发")
    sp.add_argument("--key-file", help="或直接指定私钥文件路径")
    sp.add_argument("--out", required=True, help="输出包路径（.tar.gz）")
    sp.set_defaults(func=cmd_pack)

    sp = sub.add_parser("inspect", help="验收更新包（只检查，不改变安装状态）")
    sp.add_argument("package")
    sp.set_defaults(func=cmd_inspect)

    sp = sub.add_parser("trial-install", help="验收并试装到隔离 staging 目录")
    sp.add_argument("package")
    sp.set_defaults(func=cmd_trial_install)

    sp = sub.add_parser("activate", help="把试装中的版本切换为当前版本")
    sp.add_argument("--product", required=True)
    sp.add_argument("--channel", required=True)
    sp.set_defaults(func=cmd_activate)

    sp = sub.add_parser("rollback", help="回滚到激活历史中的上一个版本")
    sp.add_argument("--product", required=True)
    sp.add_argument("--channel", required=True)
    sp.set_defaults(func=cmd_rollback)

    sp = sub.add_parser("discard-staged", help="丢弃试装中的版本")
    sp.add_argument("--product", required=True)
    sp.add_argument("--channel", required=True)
    sp.set_defaults(func=cmd_discard_staged)

    sp = sub.add_parser("status", help="查看当前安装状态")
    sp.add_argument("--product")
    sp.add_argument("--channel")
    sp.set_defaults(func=cmd_status)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "pack" and not (args.key_id or args.key_file):
        print("error: pack 需要 --key-id 或 --key-file", file=sys.stderr)
        return 2
    root = Path(args.root)
    try:
        return args.func(args, root)
    except ToolError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
