"""目录遍历与逐文件扫描。

安全边界:
- 根目录会被 realpath 规范化; 任何符号链接 (文件或目录) 解析后
  若落在根目录之外, 一律跳过并记录告警, 链接不能把扫描带出根目录;
- 版本控制目录、二进制文件、超过大小上限的文件直接跳过;
- 单个文件读取或解码失败只产生一条过程告警, 其余文件照常扫描。
"""

from __future__ import annotations

import os

from .config import Config
from .errors import ScanRootError
from .models import Finding, Warning_, make_fingerprint
from .rules import Rule, dedupe_matches

# 读文件时一次性探测的字节数上限内才做二进制嗅探; 含 NUL 即判定二进制。
_NUL_SNIFF_BYTES = 8192


class Scanner:
    def __init__(self, root: str, config: Config, rules: list[Rule]):
        self._config = config
        self._rules = rules
        if not os.path.exists(root):
            raise ScanRootError(f"扫描根目录不存在: {root}")
        if not os.path.isdir(root):
            raise ScanRootError(f"扫描根路径不是目录: {root}")
        # realpath 解析根自身可能存在的符号链接, 作为越界判断基准。
        self.root = os.path.realpath(root)
        self.findings: list[Finding] = []
        self.warnings: list[Warning_] = []
        self.skipped_binary = 0
        self.skipped_oversized = 0
        self.skipped_vcs = 0
        self.scanned_files = 0

    # ------------------------------------------------------------------
    # 路径与遍历
    # ------------------------------------------------------------------

    def _relative_posix(self, absolute_path: str) -> str:
        relative = os.path.relpath(absolute_path, self.root)
        return relative.replace(os.sep, "/")

    def _is_within_root(self, real_path: str) -> bool:
        try:
            common = os.path.commonpath([self.root, real_path])
        except ValueError:
            return False
        return common == self.root

    def _check_symlink_boundary(
        self, entry_path: str, relative_path: str, is_dir: bool
    ) -> bool:
        """返回 True 表示该链接安全 (或根本不是链接)。"""

        if not os.path.islink(entry_path):
            return True
        real_target = os.path.realpath(entry_path)
        if not self._is_within_root(real_target):
            kind = "symlink-dir" if is_dir else "symlink-file"
            self.warnings.append(
                Warning_(
                    relative_path,
                    kind,
                    "符号链接指向扫描根目录之外, 已跳过",
                )
            )
            return False
        return True

    def _walk(self) -> list[str]:
        """产出待扫描的普通文件绝对路径, 同时统计跳过项。"""

        files: list[str] = []
        for current_dir, dir_names, file_names in os.walk(self.root, followlinks=False):
            kept_dirs: list[str] = []
            for name in dir_names:
                absolute = os.path.join(current_dir, name)
                relative = self._relative_posix(absolute)
                if name in self._config.skip_vcs_dirs:
                    self.skipped_vcs += 1
                    continue
                if os.path.islink(absolute):
                    # 链接目录: 越界则不进入; 界内则安全地显式跟随一层。
                    if self._check_symlink_boundary(absolute, relative, True):
                        kept_dirs.append(name)
                    continue
                kept_dirs.append(name)
            dir_names[:] = kept_dirs

            for name in file_names:
                absolute = os.path.join(current_dir, name)
                relative = self._relative_posix(absolute)
                if os.path.islink(absolute):
                    if not self._check_symlink_boundary(absolute, relative, False):
                        continue
                files.append(absolute)
        return files

    # ------------------------------------------------------------------
    # 文件级判定与读取
    # ------------------------------------------------------------------

    def _is_binary_extension(self, path: str) -> bool:
        lowered = path.lower()
        return any(lowered.endswith(ext) for ext in self._config.binary_extensions)

    def _looks_binary(self, handle) -> bool:
        head = handle.read(_NUL_SNIFF_BYTES)
        handle.seek(0)
        return b"\x00" in head

    def _read_text(self, absolute: str, relative: str) -> str | None:
        try:
            size = os.path.getsize(absolute)
        except OSError as exc:
            self.warnings.append(
                Warning_(relative, "stat-error", f"无法获取文件信息, 已跳过: {exc}")
            )
            return None
        if size > self._config.max_file_bytes:
            self.skipped_oversized += 1
            self.warnings.append(
                Warning_(
                    relative,
                    "oversized",
                    f"文件大小 {size} 字节超过上限 "
                    f"{self._config.max_file_bytes} 字节, 已跳过",
                )
            )
            return None
        if self._is_binary_extension(absolute):
            self.skipped_binary += 1
            return None
        try:
            with open(absolute, "rb") as handle:
                if self._looks_binary(handle):
                    self.skipped_binary += 1
                    return None
                raw = handle.read()
        except OSError as exc:
            self.warnings.append(
                Warning_(relative, "read-error", f"文件不可读, 已跳过: {exc}")
            )
            return None
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            # latin-1 永远不会解码失败: 非 UTF-8 文件按单字节映射处理,
            # 行列位置仍然准确; 同时记录一条告警说明内容可能存在编码问题。
            self.warnings.append(
                Warning_(
                    relative,
                    "encoding-fallback",
                    "文件不是合法 UTF-8, 已按 latin-1 回退解码",
                )
            )
            return raw.decode("latin-1")

    # ------------------------------------------------------------------
    # 逐行检测
    # ------------------------------------------------------------------

    def _scan_text(self, relative: str, text: str) -> None:
        # splitlines(keepends=True) 保留行尾, 行号即枚举序号 + 1。
        for line_number, line in enumerate(text.splitlines(keepends=True), start=1):
            stripped = line.rstrip("\r\n")
            raw_matches = []
            for rule in self._rules:
                raw_matches.extend(rule.scan_line(stripped))
            for match in dedupe_matches(raw_matches):
                secret_text = stripped[match.start:match.end]
                self.findings.append(
                    Finding(
                        path=relative,
                        line=line_number,
                        column=match.start + 1,
                        rule_id=match.rule_id,
                        severity=match.severity,
                        reason=match.reason,
                        match_length=len(secret_text),
                        fingerprint=make_fingerprint(
                            relative, match.rule_id, secret_text
                        ),
                    )
                )

    def run(self) -> tuple[list[Finding], list[Warning_]]:
        for absolute in self._walk():
            relative = self._relative_posix(absolute)
            text = self._read_text(absolute, relative)
            if text is None:
                continue
            self.scanned_files += 1
            try:
                self._scan_text(relative, text)
            except Exception as exc:  # 防御: 单文件异常不拖垮整体扫描
                self.warnings.append(
                    Warning_(
                        relative,
                        "scan-error",
                        f"扫描该文件时发生内部错误, 已跳过: {exc.__class__.__name__}",
                    )
                )
        return self.findings, self.warnings
