"""本地安全策略管理台服务入口。

    python -m app.cli init      # 建库并可选激活基线
    python -m app.cli serve     # 启动本地服务

只绑定 127.0.0.1，不访问任何外部服务。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import APP_NAME, db_path_from_env
from .db import Database, VersionConflict
from .samples import baseline_document, list_samples
from .service import parse_document_bytes, ServiceError
from .models import digest_of, validate_document


def _open_db(path: Path) -> Database:
    return Database(path)


def cmd_init(args: argparse.Namespace) -> int:
    path = Path(args.db).expanduser().resolve()
    db = _open_db(path)
    try:
        state = db.get_active_state()
        if state["version_id"] is not None:
            print(
                f"数据库已存在生效版本 v{db.get_version_meta(state['version_id'])['version_no']}"
                f"（generation {state['generation']}），未做改动。"
            )
            print(f"数据库路径：{path}")
            return 0
        if not args.baseline:
            print(f"已初始化空数据库：{path}")
            print("未激活任何策略。可加 --baseline 激活基线样例。")
            return 0

        document = baseline_document()
        result = validate_document(document)
        if not result.ok or result.normalized is None:
            print("基线样例未能通过校验，已中止初始化。", file=sys.stderr)
            for issue in result.issues:
                print(f"  [{issue.severity}] {issue.code} {issue.path}: {issue.message}", file=sys.stderr)
            return 1
        applied = db.apply_version(
            document=result.normalized,
            digest=result.digest or digest_of(result.normalized),
            source_kind="import",
            source_note="初始化：激活基线样例",
            origin_version_id=None,
            base_generation=0,
            operation="apply",
            details={"init": True},
        )
        print(f"已初始化数据库并激活基线：v{applied['version_no']}（generation {applied['generation']}）")
        print(f"数据库路径：{path}")
        return 0
    finally:
        db.close()


def cmd_validate(args: argparse.Namespace) -> int:
    raw = Path(args.file).read_bytes()
    document = parse_document_bytes(raw)
    result = validate_document(document)
    payload = result.summary()
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    for issue in result.issues:
        print(f"[{issue.severity}] {issue.code} {issue.path}: {issue.message}")
    return 0 if result.ok else 1


def cmd_samples(args: argparse.Namespace) -> int:
    for sample in list_samples():
        print(
            f"{sample['filename']:<42} {sample['kind']:<7} {sample['title']:<12} {sample['expectation']}"
        )
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    path = Path(args.db).expanduser().resolve()
    import os

    os.environ["POLICY_DB_PATH"] = str(path)
    print(f"{APP_NAME}：http://127.0.0.1:{args.port}")
    print(f"数据库：{path}")
    uvicorn.run(
        "app.main:create_app",
        host="127.0.0.1",
        port=args.port,
        factory=True,
        log_level="info",
        reload=False,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=APP_NAME)
    parser.add_argument(
        "--db",
        default=str(db_path_from_env()),
        help="SQLite 文件路径（默认 data/policy.db，可用 POLICY_DB_PATH 覆盖）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="初始化数据库；可同时激活基线")
    init.add_argument("--baseline", action="store_true", help="激活基线样例作为 v1")
    init.set_defaults(func=cmd_init)

    validate = sub.add_parser("validate", help="在命令行校验一份策略包文件")
    validate.add_argument("file")
    validate.set_defaults(func=cmd_validate)

    samples = sub.add_parser("samples", help="列出内置样例")
    samples.set_defaults(func=cmd_samples)

    serve = sub.add_parser("serve", help="启动本地服务")
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ServiceError as exc:
        print(f"错误：{exc.message}", file=sys.stderr)
        for issue in exc.issues:
            print(f"  [{issue.get('severity')}] {issue.get('code')} {issue.get('path')}: {issue.get('message')}", file=sys.stderr)
        return 2
    except VersionConflict as exc:
        print(f"并发冲突：{exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
