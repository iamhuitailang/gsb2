"""常见服务配置的行式解析器。

只做静态文本解析：不执行任何配置或程序。解析结果保留行号，便于页面复核。
解析失败抛出 ``ConfigParseError``，由扫描层归类为 parse_error，与文件读取
失败（read_error）区分开。
"""

from __future__ import annotations

from .rules import CONFIG_PROFILES, CONFIG_SUFFIXES


class ConfigParseError(Exception):
    """配置内容无法解析（编码、语法等）。"""


def profile_for(rel_path: str) -> str | None:
    """根据相对路径识别配置类型，无法识别返回 None。"""
    name = rel_path.rsplit("/", 1)[-1].lower()
    if name in CONFIG_PROFILES:
        return CONFIG_PROFILES[name]
    for suffix, profile in CONFIG_SUFFIXES.items():
        if name.endswith(suffix):
            return profile
    return None


def _strip_comment(line: str, profile: str) -> str:
    if profile in ("systemd", "ini"):
        for marker in ("#", ";"):
            idx = line.find(marker)
            if idx >= 0:
                line = line[:idx]
    else:
        idx = line.find("#")
        if idx >= 0:
            line = line[:idx]
    return line.strip()


def parse(text: str, profile: str) -> list[dict]:
    """把配置文本解析为结构化行。

    返回元素：{"lineno", "directive", "args", "section"}
    - directive/args 均为原始字符串（大小写保留），判断时再归一化；
    - section 为 systemd/ini 的段名（如 [Service]），其余为 None。
    """
    try:
        lines = text.splitlines()
        structured: list[dict] = []
        section = None

        for lineno, raw in enumerate(lines, start=1):
            content = _strip_comment(raw, profile)
            if not content:
                continue

            if profile in ("systemd", "ini"):
                if content.startswith("[") and content.endswith("]"):
                    section = content
                    structured.append(
                        {"lineno": lineno, "directive": content, "args": "", "section": None}
                    )
                    continue
                if "=" in content:
                    key, _, value = content.partition("=")
                    structured.append(
                        {
                            "lineno": lineno,
                            "directive": key.strip(),
                            "args": value.strip(),
                            "section": section,
                        }
                    )
                else:
                    structured.append(
                        {"lineno": lineno, "directive": content, "args": "", "section": section}
                    )
                continue

            if profile == "env":
                if content.startswith(("export ", "export\t")):
                    content = content[len("export"):].strip()
                if "=" in content:
                    key, _, value = content.partition("=")
                    structured.append(
                        {"lineno": lineno, "directive": key.strip(), "args": value.strip("\"'"),
                         "section": None}
                    )
                continue

            if profile in ("nginx", "apache"):
                # 花括号是块边界，分号是指令边界；先统一替换花括号，
                # 这样单行块 "server { listen 80; }" 也不会吞掉内部指令
                for chunk in content.replace("{", ";").replace("}", ";").split(";"):
                    chunk = chunk.strip()
                    if not chunk:
                        continue
                    parts = chunk.split(None, 1)
                    structured.append(
                        {
                            "lineno": lineno,
                            "directive": parts[0],
                            "args": parts[1] if len(parts) > 1 else "",
                            "section": None,
                        }
                    )
                continue

            # sshd / generic：空白分隔的键 + 参数
            parts = content.split(None, 1)
            structured.append(
                {
                    "lineno": lineno,
                    "directive": parts[0],
                    "args": parts[1] if len(parts) > 1 else "",
                    "section": None,
                }
            )

        return structured
    except Exception as exc:  # 解析器自身的任何意外都归类为解析失败
        raise ConfigParseError(str(exc)) from exc
