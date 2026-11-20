"""运行期常量与路径配置。

所有限制都在服务端强制执行；浏览器端的提示只是 UX，不能作为安全边界。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "本地安全策略管理台"
SCHEMA_VERSION = "1.0"
SUPPORTED_SCHEMA_VERSIONS = ("1.0",)

# ---- 体积/嵌套限制（严格解析阶段） ----
MAX_REQUEST_BYTES = 2_097_152       # 外层请求体上限 2 MiB（容许 JSON 转义膨胀）
MAX_DOCUMENT_BYTES = 524_288        # 策略文档上限 512 KiB
MAX_JSON_DEPTH = 8                  # JSON 容器最大嵌套层级
# 文档级上限允许 200 条规则 × 每规则 128 个 CIDR；节点上限要能容纳这个
# 合法上限（约 4.2 万个节点），否则会出现“结构合法但被节点数拒绝”的不一致。
MAX_JSON_NODES = 60_000             # JSON 节点总数上限
MAX_JSON_STRING_BYTES = 2_048       # 单个字符串值上限
MAX_JSON_KEY_BYTES = 128            # 单个字段名上限

# ---- 策略包结构限制 ----
MAX_RULES = 200
MAX_CIDRS_PER_LIST = 64
MAX_PORTS_PER_RULE = 64
MAX_PROTOCOLS_PER_RULE = 3
MAX_FINDINGS = 200

MAX_PACKAGE_ID_LEN = 64
MAX_PACKAGE_NAME_LEN = 120
MAX_PACKAGE_DESC_LEN = 500
MAX_RULE_ID_LEN = 64
MAX_RULE_NAME_LEN = 120
MAX_RULE_DESC_LEN = 300
MAX_CIDR_LEN = 64
MAX_SOURCE_NOTE_LEN = 200
MAX_AUDIT_DETAILS_BYTES = 16_384

COMPONENT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = COMPONENT_DIR.parent
DEFAULT_DATA_DIR = PROJECT_DIR / "data"
DEFAULT_DB_PATH = DEFAULT_DATA_DIR / "policy.db"
WEB_DIR = PROJECT_DIR / "web"
SAMPLES_DIR = PROJECT_DIR / "samples"


def db_path_from_env() -> Path:
    raw = os.environ.get("POLICY_DB_PATH")
    if raw:
        return Path(raw).expanduser().resolve()
    return DEFAULT_DB_PATH
