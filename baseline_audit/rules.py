"""基线规则目录。

每条规则有稳定的 ``id``、风险等级、标题与判断说明。规则集带有版本号和
内容指纹：规则增删改会改变指纹，历史结果会据此提示"规则版本已变化"，
不会静默沿用旧结论。
"""

from __future__ import annotations

import hashlib
import json

SEVERITIES = ("high", "medium", "low")

# 规则版本：人工维护的版本号 + 由规则内容自动计算的指纹，两者都会写入报告
RULES_VERSION = "1.0.0"

RULES: dict[str, dict] = {
    # ---- 文件/目录权限类 ----
    "PERM-WORLD-WRITABLE-FILE": {
        "severity": "high",
        "title": "文件对所有用户可写",
        "rationale": "任意本地用户都能修改该文件，可能篡改程序或配置导致提权。",
        "remediation": "去除 other 写位，例如 chmod o-w，并按最小权限重新设置属主。",
    },
    "PERM-WORLD-WRITABLE-DIR": {
        "severity": "medium",
        "title": "目录对所有用户可写且无粘滞位",
        "rationale": "任意用户可在该目录创建、删除或替换文件；没有粘滞位时连他人文件也可删除。",
        "remediation": "去除 other 写位，或对公共写入目录设置粘滞位 chmod +t。",
    },
    "PERM-SETUID": {
        "severity": "high",
        "title": "文件设置了 setuid 位",
        "rationale": "setuid 程序以属主（常为 root）身份执行，存在漏洞即可能被用于提权。",
        "remediation": "确认业务必要性，否则 chmod u-s；必要时改用能力机制(capabilities)。",
    },
    "PERM-SETGID": {
        "severity": "medium",
        "title": "文件设置了 setgid 位",
        "rationale": "setgid 程序执行时继承文件属组权限，扩大了攻击面。",
        "remediation": "确认业务必要性，否则 chmod g-s。",
    },
    "PERM-SENSITIVE-WORLD-READABLE": {
        "severity": "medium",
        "title": "敏感文件对所有用户可读",
        "rationale": "密钥、凭据、环境文件若全局可读，任何本地用户都可读取其中的机密。",
        "remediation": "收紧为属主可读，例如 chmod 600，并核查是否需要轮换其中凭据。",
    },
    "PERM-GROUP-WRITABLE-CONFIG": {
        "severity": "low",
        "title": "配置文件组可写",
        "rationale": "同组任意用户可修改服务配置，权限边界偏宽。",
        "remediation": "去除 group 写位 chmod g-w，或收紧属组范围。",
    },
    # ---- 服务配置类 ----
    "SVC-SSHD-PERMIT-ROOT-LOGIN": {
        "severity": "high",
        "title": "sshd 允许 root 直接登录",
        "rationale": "PermitRootLogin 开启后，攻击者可直接对最高权限账号尝试登录。",
        "remediation": "设置 PermitRootLogin no，使用普通账号登录后再提权。",
    },
    "SVC-SSHD-PASSWORD-AUTH": {
        "severity": "medium",
        "title": "sshd 启用口令认证",
        "rationale": "口令可被暴力破解或钓鱼获取；密钥认证的抗攻击性更好。",
        "remediation": "部署公钥认证后设置 PasswordAuthentication no。",
    },
    "SVC-NGINX-HTTP-LISTEN": {
        "severity": "low",
        "title": "nginx 监听明文 HTTP 端口",
        "rationale": "明文端口上的流量可被窃听或篡改；应配置 TLS 或由前置网关统一卸载。",
        "remediation": "配置 listen 443 ssl 并将 80 端口重定向到 HTTPS。",
    },
    "SVC-APACHE-HTTP-LISTEN": {
        "severity": "low",
        "title": "Apache 监听明文 HTTP 端口",
        "rationale": "明文端口上的流量可被窃听或篡改；应配置 TLS 或由前置网关统一卸载。",
        "remediation": "启用 mod_ssl，配置 https 监听并把 HTTP 重定向到 HTTPS。",
    },
    "SVC-SYSTEMD-ROOT-USER": {
        "severity": "low",
        "title": "systemd 服务以 root 运行",
        "rationale": "服务被攻破后直接获得 root 权限；无特殊需求应使用低权限专用账号。",
        "remediation": "在 [Service] 中设置 User= 为专用低权限账号。",
    },
    "SVC-SYSTEMD-WRITABLE-EXEC": {
        "severity": "high",
        "title": "systemd 启动路径组可写或全局可写",
        "rationale": "ExecStart 指向的程序若可被他人改写，服务启动时即执行被植入的内容。",
        "remediation": "收紧可执行文件及其目录权限，确保仅属主可写。",
    },
    "SVC-INSECURE-BIND-ALL": {
        "severity": "low",
        "title": "服务监听 0.0.0.0，对所有网卡暴露",
        "rationale": "绑定全部网卡会把内部服务暴露到不必要的网络面上。",
        "remediation": "无对外需求时绑定 127.0.0.1 或指定内网网卡。",
    },
    "SVC-PLAINTEXT-SECRET": {
        "severity": "high",
        "title": "配置文件中存在明文口令或令牌",
        "rationale": "明文凭据一旦随备份、日志、镜像扩散即失控；本工具不会展示其内容。",
        "remediation": "改用密钥管理/环境注入机制，并立即轮换该凭据。",
    },
}

# 按文件名（basename 小写）识别的服务配置
CONFIG_PROFILES: dict[str, str] = {
    "sshd_config": "sshd",
    "nginx.conf": "nginx",
    "httpd.conf": "apache",
    "apache2.conf": "apache",
}

# 按后缀识别的服务配置
CONFIG_SUFFIXES: dict[str, str] = {
    ".service": "systemd",
    ".env": "env",
    ".ini": "ini",
    ".conf": "generic",
    ".cfg": "generic",
    ".config": "generic",
}

# 视为敏感、默认不应全局可读的文件名片段
SENSITIVE_NAME_FRAGMENTS = (
    "credential",
    "secret",
    "passwd",
    "password",
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
)
SENSITIVE_NAME_SUFFIXES = (".pem", ".key", ".p12", ".pfx")


def rules_fingerprint() -> str:
    """对规则目录本身取指纹，规则任何增删改都会改变它。"""
    payload = json.dumps(
        {"version": RULES_VERSION, "rules": RULES}, sort_keys=True, ensure_ascii=False
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


def get_rule(rule_id: str) -> dict:
    return RULES[rule_id]
