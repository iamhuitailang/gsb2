"""安装状态管理：试装（staging）、激活、回滚、并发锁、结果日志。

目录结构（都在 --root 下）：
  install/<product>/<channel>/
    state.json          当前版本、激活历史、试装中的版本（原子写）
    staging/            试装内容（验收通过后放这里，不影响当前版本）
    versions/<version>/ 已激活版本的完整内容
  lock                  互斥锁文件（带 pid，进程死亡后自动识别陈旧锁）
  logs/results.jsonl    可读的结果记录（绝不包含私钥或完整密钥材料）

崩溃恢复：
- state.json 先写 .tmp 再 os.replace，启动时清理残留的 .tmp；
- 激活在"移动文件"和"写状态"之间崩溃后，state 仍指向旧版本，
  重新执行 activate 会发现 versions/<v> 已就绪，直接补写状态完成激活；
- 用环境变量 UPDATE_TOOL_CRASH_AT=before-move|after-move|after-state
  可以在不手工改文件的前提下注入激活中断。
"""
from __future__ import annotations

import json
import os
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import manifest as mf
from .errors import LockedError, StoreError


def _crashpoint(name: str):
    """激活中断注入点：环境变量匹配时立即终止进程（模拟断电/崩溃）。"""
    if os.environ.get("UPDATE_TOOL_CRASH_AT") == name:
        os._exit(1)


class Store:
    def __init__(self, root):
        self.root = Path(root)

    # ---------- 并发互斥 ----------

    @contextmanager
    def lock(self):
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / "lock"
        acquired = False
        for _attempt in (1, 2):
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                acquired = True
                break
            except FileExistsError:
                if self._lock_is_stale(lock_path):
                    try:
                        lock_path.unlink()
                    except FileNotFoundError:
                        pass
                    continue
                raise LockedError(
                    "另一个更新操作正在进行（lock 文件存在）；"
                    "若确认对方已退出，删除该 lock 文件或等自动识别后重试"
                )
        if not acquired:  # 理论上不会到这里
            raise LockedError("无法获取更新锁")
        try:
            yield
        finally:
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _lock_is_stale(lock_path: Path) -> bool:
        try:
            pid = int(lock_path.read_text().strip() or "0")
        except (ValueError, OSError):
            return False
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True  # 持锁进程已死，锁是陈旧的
        except PermissionError:
            return False  # 进程存在但无权发信号，视为活跃
        return False

    # ---------- 状态读写 ----------

    def _channel_dir(self, product: str, channel: str) -> Path:
        return self.root / "install" / product / channel

    def load_state(self, product: str, channel: str) -> dict:
        d = self._channel_dir(product, channel)
        tmp = d / "state.json.tmp"
        if tmp.exists():
            tmp.unlink()  # 上次写状态时被中断，.tmp 是半成品，丢弃
        state_file = d / "state.json"
        if state_file.exists():
            return json.loads(state_file.read_text(encoding="utf-8"))
        return {
            "product": product,
            "channel": channel,
            "current": None,
            "history": [],
            "staged": None,
        }

    def save_state(self, state: dict):
        d = self._channel_dir(state["product"], state["channel"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "state.json.tmp"
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, d / "state.json")

    # ---------- 结果日志（不含任何私钥材料） ----------

    def log(self, action, product, channel, version, ok, detail=""):
        log_dir = self.root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "action": action,
            "product": product,
            "channel": channel,
            "version": version,
            "ok": ok,
            "detail": detail,
        }
        with open(log_dir / "results.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")

    # ---------- 试装 / 激活 / 回滚 ----------

    def trial_install(self, info: dict, payload_dir):
        """验收通过后，把负载放进 staging。不触碰当前生效版本。"""
        product, channel, version = info["product"], info["channel"], info["version"]
        with self.lock():
            state = self.load_state(product, channel)
            staged = state.get("staged")
            if staged and staged["version"] != version:
                raise StoreError(
                    f"已有版本 {staged['version']} 在试装中；"
                    f"请先 activate 或 discard-staged"
                )
            d = self._channel_dir(product, channel)
            d.mkdir(parents=True, exist_ok=True)
            staging = d / "staging"
            if staging.exists():
                shutil.rmtree(staging)
            os.rename(str(payload_dir), str(staging))
            state["staged"] = {"version": version}
            self.save_state(state)
            self.log("trial-install", product, channel, version, True,
                     f"staged {len(info['files'])} files, signer {info['key_id']}")
        return version

    def activate(self, product: str, channel: str) -> str:
        """把试装中的版本切换为当前版本。版本必须按通道单调前进。"""
        with self.lock():
            state = self.load_state(product, channel)
            staged = state.get("staged")
            if not staged:
                raise StoreError("没有试装中的版本，请先 trial-install")
            version = staged["version"]
            current = state["current"]
            if current is not None and mf.version_tuple(version) <= mf.version_tuple(current):
                raise StoreError(
                    f"版本 {version} 不大于当前版本 {current}，拒绝激活"
                    "（同一通道内版本只能单调前进；旧版本请用 rollback 显式回退）"
                )
            d = self._channel_dir(product, channel)
            staging = d / "staging"
            target = d / "versions" / version
            _crashpoint("before-move")
            if staging.exists():
                if target.exists():
                    raise StoreError(f"版本目录已存在: {target}，拒绝覆盖")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.rename(str(staging), str(target))
            elif not target.exists():
                raise StoreError("试装内容丢失且版本未安装，请重新 trial-install")
            # 若上次在移动后、写状态前崩溃：staging 已不在、target 已就绪，
            # 走到这里直接补写状态即可完成激活。
            _crashpoint("after-move")
            if version not in state["history"]:
                state["history"].append(version)
            state["current"] = version
            state["staged"] = None
            self.save_state(state)
            _crashpoint("after-state")
            self.log("activate", product, channel, version, True, "activated")
            return version

    def discard_staged(self, product: str, channel: str):
        with self.lock():
            state = self.load_state(product, channel)
            staged = state.get("staged")
            staging = self._channel_dir(product, channel) / "staging"
            if staging.exists():
                shutil.rmtree(staging)
            state["staged"] = None
            self.save_state(state)
            if staged:
                self.log("discard-staged", product, channel,
                         staged["version"], True, "staged content discarded")
            return staged

    def rollback(self, product: str, channel: str) -> str:
        """回退到激活历史中的上一个版本（显式操作，不受单调前进限制）。"""
        with self.lock():
            state = self.load_state(product, channel)
            current = state["current"]
            if current is None:
                raise StoreError("当前没有已激活的版本，无法回滚")
            history = state["history"]
            idx = history.index(current) if current in history else -1
            if idx <= 0:
                raise StoreError("没有更早的版本可以回退")
            target = history[idx - 1]
            version_dir = self._channel_dir(product, channel) / "versions" / target
            if not version_dir.is_dir():
                raise StoreError(f"版本 {target} 的内容目录缺失，无法回滚")
            state["current"] = target
            self.save_state(state)
            self.log("rollback", product, channel, target, True,
                     f"rolled back from {current}")
            return target

    # ---------- 状态查询 ----------

    def status(self, product=None, channel=None) -> list:
        install = self.root / "install"
        results = []
        if not install.is_dir():
            return results
        for p_dir in sorted(install.iterdir()):
            if not p_dir.is_dir():
                continue
            for c_dir in sorted(p_dir.iterdir()):
                if not c_dir.is_dir():
                    continue
                if product and p_dir.name != product:
                    continue
                if channel and c_dir.name != channel:
                    continue
                if (c_dir / "state.json").exists():
                    results.append(self.load_state(p_dir.name, c_dir.name))
        return results
