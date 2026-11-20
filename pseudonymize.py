#!/usr/bin/env python3
"""pseudonymize — 本地 CSV 敏感字段假名化命令行工具。

把多份 CSV 中配置的敏感列替换为带密钥保护的稳定假名，其他列原样保留。
仅使用 Python 标准库，不访问任何网络服务。用法详见 README.md。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import csv
import hashlib
import hmac
import json
import os
import secrets
import sys
import tempfile

KEY_BYTES = 32
PSEUDONYM_HEX_LEN = 16  # 64 bit 截断，碰撞概率对台账级数据量可忽略
PSEUDONYM_PREFIX = "psm"
DEFAULT_SCOPE = "default"
DEFAULT_KEY_VERSION = "v1"
KEY_VERSION_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)
NORMALIZE_MODES = ("raw", "strip", "lower", "strip_lower")


class PseudonymError(Exception):
    """工具内所有可预期错误的基类，信息面向用户可读。"""


class ConfigError(PseudonymError):
    """任务配置或输入表头不合法。"""


class KeyLoadError(PseudonymError):
    """密钥文件缺失或损坏。错误信息绝不包含密钥内容。"""


class ProcessingError(PseudonymError):
    """处理或写出阶段失败。"""


# ---------------------------------------------------------------------------
# 值归一化与假名生成
# ---------------------------------------------------------------------------

def normalize_value(value: str, mode: str) -> str:
    """按声明方式归一化待比较文本。所有值一律按字符串处理，不做数字推断，
    因此 "00123" 的前导零不会丢失。"""
    if mode == "raw":
        return value
    if mode == "strip":
        return value.strip()
    if mode == "lower":
        return value.casefold()
    if mode == "strip_lower":
        return value.strip().casefold()
    raise ConfigError(f"未知的归一化方式: {mode!r}（可选: {', '.join(NORMALIZE_MODES)}）")


def make_pseudonym(key: bytes, key_version: str, scope: str, field: str, value: str) -> str:
    """对归一化后的值生成假名。

    HMAC 输入包含关联范围与逻辑字段名，实现两级域分离：
    同一范围同一字段内结果稳定，跨范围/跨字段互不可关联。
    输出携带密钥版本便于轮换识别，但不包含密钥本身。
    """
    msg = b"\x00".join(
        (scope.encode("utf-8"), field.encode("utf-8"), value.encode("utf-8"))
    )
    digest = hmac.new(key, msg, hashlib.sha256).hexdigest()
    return f"{PSEUDONYM_PREFIX}-{key_version}-{digest[:PSEUDONYM_HEX_LEN]}"


# ---------------------------------------------------------------------------
# 密钥管理
# ---------------------------------------------------------------------------

def _validate_key_version(key_version: str) -> None:
    if not key_version or any(c not in KEY_VERSION_CHARS for c in key_version):
        raise ConfigError(
            f"密钥版本 {key_version!r} 不合法：只能包含字母、数字、'.'、'_'、'-'"
        )


def generate_key_file(path: str, key_version: str = DEFAULT_KEY_VERSION) -> None:
    """生成新密钥文件。已存在时拒绝覆盖，权限固定为 0600。"""
    _validate_key_version(key_version)
    key = secrets.token_bytes(KEY_BYTES)
    payload = {
        "key_version": key_version,
        "key": base64.b64encode(key).decode("ascii"),
    }
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ConfigError(f"密钥文件已存在，拒绝覆盖: {path}")
    except OSError as exc:
        raise KeyLoadError(f"无法创建密钥文件: {path}（{exc.strerror or exc}）")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f)
        f.write("\n")


def load_key(path: str) -> tuple[str, bytes]:
    """读取密钥文件，返回 (密钥版本, 密钥字节)。

    所有解析失败只报告文件路径与错误类型，不把文件内容写进错误信息，
    避免密钥随日志外泄。
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except FileNotFoundError:
        raise KeyLoadError(f"密钥文件不存在: {path}（请先运行 init-key）")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise KeyLoadError(f"密钥文件格式无效: {path}")
    except OSError as exc:
        raise KeyLoadError(f"密钥文件读取失败: {path}（{exc.strerror or exc}）")

    if not isinstance(payload, dict):
        raise KeyLoadError(f"密钥文件格式无效: {path}")
    key_version = payload.get("key_version")
    key_b64 = payload.get("key")
    if not isinstance(key_version, str) or not isinstance(key_b64, str):
        raise KeyLoadError(f"密钥文件缺少必要字段: {path}")
    try:
        _validate_key_version(key_version)
    except ConfigError:
        raise KeyLoadError(f"密钥文件中的密钥版本不合法: {path}")
    try:
        key = base64.b64decode(key_b64, validate=True)
    except (binascii.Error, ValueError):
        raise KeyLoadError(f"密钥文件中的密钥编码无效: {path}")
    if len(key) != KEY_BYTES:
        raise KeyLoadError(f"密钥文件中的密钥长度无效: {path}")

    try:
        mode = os.stat(path).st_mode
        if mode & 0o077:
            print(
                f"警告: 密钥文件 {path} 权限过于宽松，建议 chmod 600",
                file=sys.stderr,
            )
    except OSError:
        pass
    return key_version, key


# ---------------------------------------------------------------------------
# 任务配置
# ---------------------------------------------------------------------------

def load_config(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"配置文件不存在: {path}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置文件不是合法 JSON: {path}（第 {exc.lineno} 行）")
    except OSError as exc:
        raise ConfigError(f"配置文件读取失败: {path}（{exc.strerror or exc}）")
    return validate_config(cfg, base_dir=os.path.dirname(os.path.abspath(path)))


def validate_config(cfg: object, base_dir: str = ".") -> dict:
    """校验并归一化任务配置。所有规则冲突都在这里报出，发生在任何写文件之前。"""
    if not isinstance(cfg, dict):
        raise ConfigError("配置顶层必须是 JSON 对象")
    key_file = cfg.get("key_file")
    if not isinstance(key_file, str) or not key_file:
        raise ConfigError("配置缺少 key_file（密钥文件路径）")
    files = cfg.get("files")
    if not isinstance(files, list) or not files:
        raise ConfigError("配置缺少非空的 files 列表")

    def resolve(p: str) -> str:
        return p if os.path.isabs(p) else os.path.normpath(os.path.join(base_dir, p))

    norm_files = []
    seen_inputs: set[str] = set()
    seen_outputs: set[str] = set()
    for i, entry in enumerate(files):
        where = f"files[{i}]"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where} 必须是对象")
        inp, outp = entry.get("input"), entry.get("output")
        if not isinstance(inp, str) or not inp:
            raise ConfigError(f"{where} 缺少 input 路径")
        if not isinstance(outp, str) or not outp:
            raise ConfigError(f"{where} 缺少 output 路径")
        inp, outp = resolve(inp), resolve(outp)
        if inp in seen_inputs:
            raise ConfigError(f"输入文件重复配置: {inp}")
        if outp in seen_outputs:
            raise ConfigError(f"输出文件重复配置: {outp}")
        if inp == outp:
            raise ConfigError(f"输入与输出路径相同，拒绝原地改写: {inp}")
        seen_inputs.add(inp)
        seen_outputs.add(outp)

        columns = entry.get("columns")
        if not isinstance(columns, list) or not columns:
            raise ConfigError(f"{where} 缺少非空的 columns 列表")
        norm_columns = []
        seen_names: set[str] = set()
        for j, col in enumerate(columns):
            cwhere = f"{where}.columns[{j}]"
            if not isinstance(col, dict):
                raise ConfigError(f"{cwhere} 必须是对象")
            name = col.get("name")
            if not isinstance(name, str) or not name:
                raise ConfigError(f"{cwhere} 缺少列名 name")
            if name in seen_names:
                raise ConfigError(f"{where} 中列 {name!r} 配置了重复规则")
            seen_names.add(name)
            mode = col.get("normalize", "raw")
            if mode not in NORMALIZE_MODES:
                raise ConfigError(
                    f"{cwhere} 的 normalize 无效: {mode!r}"
                    f"（可选: {', '.join(NORMALIZE_MODES)}）"
                )
            field = col.get("field", name)
            scope = col.get("scope", DEFAULT_SCOPE)
            if not isinstance(field, str) or not field:
                raise ConfigError(f"{cwhere} 的 field 必须是非空字符串")
            if not isinstance(scope, str) or not scope:
                raise ConfigError(f"{cwhere} 的 scope 必须是非空字符串")
            norm_columns.append(
                {"name": name, "field": field, "scope": scope, "normalize": mode}
            )
        norm_files.append({"input": inp, "output": outp, "columns": norm_columns})

    return {
        "key_file": resolve(key_file),
        "files": norm_files,
    }


# ---------------------------------------------------------------------------
# CSV 处理
# ---------------------------------------------------------------------------

def read_header(path: str) -> list[str]:
    try:
        with open(path, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            try:
                return next(reader)
            except StopIteration:
                raise ConfigError(f"输入文件为空（没有表头）: {path}")
    except UnicodeDecodeError:
        raise ConfigError(f"输入文件不是有效的 UTF-8 文本: {path}")
    except OSError as exc:
        raise ConfigError(f"输入文件读取失败: {path}（{exc.strerror or exc}）")


def plan_columns(spec: dict) -> list[tuple[int, dict]]:
    """根据表头把列规则解析为列下标；列名缺失或表头重复时立即报错。"""
    header = read_header(spec["input"])
    index: dict[str, int] = {}
    for i, name in enumerate(header):
        if name in index:
            raise ConfigError(f"输入文件表头存在重复列名 {name!r}: {spec['input']}")
        index[name] = i
    plan = []
    for rule in spec["columns"]:
        if rule["name"] not in index:
            raise ConfigError(
                f"输入文件 {spec['input']} 中找不到配置的列 {rule['name']!r}"
            )
        plan.append((index[rule["name"]], rule))
    return plan


def process_file(spec: dict, plan: list[tuple[int, dict]],
                 key: bytes, key_version: str, temp_path: str) -> int:
    """把单个输入处理到临时文件，返回数据行数。空值/缺失值一律输出为空字符串。"""
    src, dst = spec["input"], temp_path
    rows = 0
    with open(src, "r", newline="", encoding="utf-8-sig") as fin, \
         open(dst, "w", newline="", encoding="utf-8") as fout:
        reader = csv.reader(fin)
        writer = csv.writer(fout, lineterminator="\n")
        header = next(reader)
        writer.writerow(header)
        width = len(header)
        for lineno, row in enumerate(reader, start=2):
            if not row:  # 原始空行原样保留
                writer.writerow(row)
                continue
            if len(row) > width:
                raise ProcessingError(
                    f"{src}: 第 {lineno} 行有 {len(row)} 列，多于表头的 {width} 列"
                )
            if len(row) < width:  # 行尾缺失按空值补齐
                row = row + [""] * (width - len(row))
            for idx, rule in plan:
                normalized = normalize_value(row[idx], rule["normalize"])
                if normalized == "":
                    row[idx] = ""
                else:
                    row[idx] = make_pseudonym(
                        key, key_version, rule["scope"], rule["field"], normalized
                    )
            writer.writerow(row)
            rows += 1
    return rows


# ---------------------------------------------------------------------------
# 多文件整体提交
# ---------------------------------------------------------------------------

def _commit_file(tmp_path: str, dst: str) -> None:
    """把临时文件落位到目标路径；目标已存在时失败而不是覆盖。"""
    try:
        os.link(tmp_path, dst)
    except FileExistsError:
        raise ProcessingError(f"输出文件已存在，拒绝覆盖: {dst}")
    except OSError as exc:
        raise ProcessingError(f"写入输出文件失败: {dst}（{exc.strerror or exc}）")


def run_task(config_path: str, report_path: str | None = None) -> dict:
    """执行一次假名化任务，返回运行报告（不含任何原始值或映射关系）。"""
    cfg = load_config(config_path)
    key_version, key = load_key(cfg["key_file"])

    # 第一阶段：全部校验，任何错误都发生在写文件之前。
    plans = [(spec, plan_columns(spec)) for spec in cfg["files"]]
    outputs = [spec["output"] for spec in cfg["files"]]
    if report_path:
        report_path = os.path.abspath(report_path)
        outputs.append(report_path)
    for out in outputs:
        if os.path.exists(out):
            raise ConfigError(f"目标文件已存在，拒绝覆盖: {out}")

    # 第二阶段：逐文件写入各自输出目录下的临时文件。
    temps: list[tuple[str, str]] = []  # (临时文件, 最终路径)
    stats: list[dict] = []
    try:
        for spec, plan in plans:
            outdir = os.path.dirname(spec["output"]) or "."
            os.makedirs(outdir, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".pseudonymize-", dir=outdir)
            os.close(fd)
            temps.append((tmp, spec["output"]))
            rows = process_file(spec, plan, key, key_version, tmp)
            stats.append({
                "input": spec["input"],
                "output": spec["output"],
                "rows": rows,
                "pseudonymized_columns": [r["name"] for _, r in plan],
            })
    except Exception:
        for tmp, _ in temps:
            _silent_unlink(tmp)
        raise

    # 第三阶段：整体落位。中途失败时撤销已落位的文件，不留半成品。
    committed: list[str] = []
    try:
        for tmp, dst in temps:
            _commit_file(tmp, dst)
            committed.append(dst)
    except Exception:
        for dst in committed:
            _silent_unlink(dst)
        raise
    finally:
        for tmp, _ in temps:
            _silent_unlink(tmp)

    report = {
        "key_version": key_version,
        "files": stats,
        "total_rows": sum(s["rows"] for s in stats),
    }
    if report_path:
        _write_report(report, report_path)
    return report


def _write_report(report: dict, path: str) -> None:
    outdir = os.path.dirname(path) or "."
    os.makedirs(outdir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".pseudonymize-report-", dir=outdir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
            f.write("\n")
        _commit_file(tmp, path)
    except ProcessingError:
        raise
    except OSError as exc:
        raise ProcessingError(f"报告写入失败: {path}（{exc.strerror or exc}）")
    finally:
        _silent_unlink(tmp)


def _silent_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pseudonymize",
        description="本地 CSV 敏感字段假名化工具（仅本地运行，不访问网络）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init-key", help="生成新的本地密钥文件")
    p_init.add_argument("--key-file", required=True, help="密钥文件输出路径")
    p_init.add_argument("--key-version", default=DEFAULT_KEY_VERSION,
                        help="密钥版本标识（默认 v1）")

    p_run = sub.add_parser("run", help="按任务配置执行假名化")
    p_run.add_argument("--config", required=True, help="任务配置 JSON 路径")
    p_run.add_argument("--report", default=None, help="运行报告输出路径（可选）")

    args = parser.parse_args(argv)
    try:
        if args.command == "init-key":
            generate_key_file(args.key_file, args.key_version)
            print(f"已生成密钥文件: {args.key_file}（版本 {args.key_version}）")
            print("请妥善保管该文件，不要提交到版本库或随数据外发。", file=sys.stderr)
        else:
            report = run_task(args.config, args.report)
            print(json.dumps(report, ensure_ascii=False, indent=2))
    except PseudonymError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # 兜底：只报异常类型，避免意外带出敏感内容
        print(f"错误: 未预期的失败（{exc.__class__.__name__}）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
