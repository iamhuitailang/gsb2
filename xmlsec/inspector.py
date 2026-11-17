"""安全 XML 检查核心。

基于 xml.parsers.expat 的流式解析，并做如下约束：

- 外部 DTD 子集 / 外部实体 / 外部资源引用：一律拒绝加载（expat 本身
  不会主动抓取，我们显式关闭参数实体解析并在回调中记录拒绝原因）。
- 内部实体允许在限额内展开，展开输出与放大倍数实时监控，超限即终止。
- 嵌套深度、元素数量、属性数量、文本输出量、输入大小均有上限，
  触发即终止解析并报告是哪一条限制。

解析结果（树、诊断、统计）全部以可 JSON 序列化的字典返回。
"""

from __future__ import annotations

import time
import xml.parsers.expat as expat

# 各项处理限制。tests 与前端都会读取，保持集中定义。
LIMITS = {
    "max_input_bytes": 512 * 1024,      # 输入报文最大字节数
    "max_depth": 64,                    # 元素最大嵌套深度
    "max_elements": 20000,              # 元素总数上限
    "max_attributes_per_element": 256,  # 单元素属性数上限
    "max_text_chars": 500_000,          # 文本输出总字符上限
    "max_expansion_chars": 200_000,     # 存在自定义实体时的文本输出上限
    "max_expansion_ratio": 50.0,        # 实体放大倍数上限（输出字符 / 已消耗输入字节）
    "max_entity_decls": 100,            # 实体声明数量上限
    "max_declared_entity_bytes": 100_000,  # 实体声明值的总字节上限
}

# 诊断级别
SEV_ERROR = "error"      # 格式错误（well-formedness）
SEV_BLOCKED = "blocked"  # 已阻止的危险构造
SEV_LIMIT = "limit"      # 触发处理限制，解析被终止
SEV_INFO = "info"        # 正常信息


class _Abort(Exception):
    """在解析回调中抛出，用于触发限制后立刻终止解析。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _split_qname(raw: str) -> dict:
    """expat 开启命名空间后返回 'uri local [prefix]'，拆开便于展示。"""
    parts = raw.split(" ")
    if len(parts) == 3:
        return {"namespace": parts[0], "local": parts[1], "prefix": parts[2]}
    if len(parts) == 2:
        return {"namespace": parts[0], "local": parts[1], "prefix": None}
    return {"namespace": None, "local": raw, "prefix": None}


def _display_name(q: dict) -> str:
    return f"{q['prefix']}:{q['local']}" if q.get("prefix") else q["local"]


def inspect_xml(text, limits: dict | None = None) -> dict:
    """检查一段 XML，返回 {status, diagnostics, tree, stats, limits}。

    status: ok | blocked | error | limited
    """
    started = time.monotonic()
    lim = dict(LIMITS)
    if limits:
        lim.update(limits)

    diagnostics: list[dict] = []

    def diag(severity, code, message, line=None, column=None):
        diagnostics.append({
            "severity": severity,
            "code": code,
            "message": message,
            "line": line,
            "column": column,
        })

    # --- 输入大小限制（最先检查，避免大输入占用内存） ---
    if isinstance(text, bytes):
        raw = text
    else:
        raw = text.encode("utf-8", "replace")
    input_bytes = len(raw)
    if input_bytes > lim["max_input_bytes"]:
        diag(
            SEV_LIMIT, "input_size",
            f"输入大小超限：{input_bytes} 字节，上限 {lim['max_input_bytes']} 字节，处理已终止",
        )
        return _result("limited", diagnostics, None, started, input_bytes, lim)

    # --- 解析状态 ---
    root = {"type": "document", "children": []}
    stack = [root]
    depth = 0
    max_depth_seen = 0
    elem_count = 0
    text_chars = 0
    entity_decls = 0
    declared_entity_bytes = 0
    in_cdata = False
    pending_ns: list[dict] = []

    parser = expat.ParserCreate(namespace_separator=" ")
    parser.namespace_prefixes = True
    # 显式关闭参数实体解析：外部 DTD 子集永远不会被读取。
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)

    def pos():
        return parser.CurrentLineNumber, parser.CurrentColumnNumber

    def abort(code, message):
        line, col = pos()
        raise _Abort(code, f"{message}（第 {line} 行，第 {col} 列）")

    # --- 回调 ---
    def on_start_element(name, attrs):
        nonlocal depth, max_depth_seen, elem_count
        depth += 1
        max_depth_seen = max(max_depth_seen, depth)
        if depth > lim["max_depth"]:
            abort("max_depth", f"嵌套深度超限：达到 {depth} 层，上限 {lim['max_depth']} 层")
        elem_count += 1
        if elem_count > lim["max_elements"]:
            abort("max_elements", f"元素数量超限：超过 {lim['max_elements']} 个")
        if len(attrs) > lim["max_attributes_per_element"]:
            abort("max_attributes", f"单元素属性数量超限：上限 {lim['max_attributes_per_element']} 个")

        q = _split_qname(name)
        line, col = pos()
        node = {
            "type": "element",
            "name": _display_name(q),
            "local": q["local"],
            "namespace": q["namespace"],
            "prefix": q["prefix"],
            "attributes": [],
            "namespaces": list(pending_ns),
            "children": [],
            "line": line,
            "column": col,
        }
        for attr_name, value in attrs.items():
            aq = _split_qname(attr_name)
            node["attributes"].append({
                "name": _display_name(aq),
                "local": aq["local"],
                "namespace": aq["namespace"],
                "prefix": aq["prefix"],
                "value": value,
            })
        pending_ns.clear()
        stack[-1]["children"].append(node)
        stack.append(node)

    def on_end_element(name):
        nonlocal depth
        depth -= 1
        stack.pop()

    def on_char_data(data):
        nonlocal text_chars
        if not data:
            return
        text_chars += len(data)
        if text_chars > lim["max_text_chars"]:
            abort("max_text_chars", f"文本输出超限：超过 {lim['max_text_chars']} 字符")
        if entity_decls:
            # 文档声明了自定义实体：监控展开规模与放大倍数。
            if text_chars > lim["max_expansion_chars"]:
                abort(
                    "entity_expansion_chars",
                    f"实体展开超限：展开输出超过 {lim['max_expansion_chars']} 字符，疑似实体炸弹",
                )
            consumed = max(1, parser.CurrentByteIndex)
            if text_chars > 4096 and text_chars > consumed * lim["max_expansion_ratio"]:
                abort(
                    "entity_expansion_ratio",
                    f"实体展开超限：输出 {text_chars} 字符，已消耗输入 {consumed} 字节，"
                    f"放大倍数超过 {lim['max_expansion_ratio']:g} 倍，疑似实体炸弹",
                )
        parent = stack[-1]
        children = parent["children"]
        if children and children[-1]["type"] == "text" and children[-1]["cdata"] == in_cdata:
            children[-1]["content"] += data
        else:
            line, col = pos()
            children.append({
                "type": "text",
                "content": data,
                "cdata": in_cdata,
                "line": line,
                "column": col,
            })

    def on_comment(data):
        line, col = pos()
        stack[-1]["children"].append({
            "type": "comment", "content": data, "line": line, "column": col,
        })

    def on_pi(target, data):
        line, col = pos()
        stack[-1]["children"].append({
            "type": "pi", "target": target, "content": data,
            "line": line, "column": col,
        })

    def on_start_cdata():
        nonlocal in_cdata
        in_cdata = True

    def on_end_cdata():
        nonlocal in_cdata
        in_cdata = False

    def on_start_ns(prefix, uri):
        pending_ns.append({"prefix": prefix or "", "uri": uri})

    def on_xml_decl(version, encoding, standalone):
        diag(SEV_INFO, "xml_decl", f"XML 声明：version={version} encoding={encoding}")

    def on_start_doctype(name, sysid, pubid, has_internal_subset):
        line, col = pos()
        diag(
            SEV_BLOCKED, "doctype",
            f"文档类型定义 <!DOCTYPE {name}> 已按危险构造处理：不加载外部 DTD 子集、"
            f"不解析参数实体，内部实体仅在限额内展开（第 {line} 行）",
            line, col,
        )
        if sysid:
            diag(
                SEV_BLOCKED, "external_dtd",
                f"外部 DTD 子集 '{sysid}' 已拒绝加载：安全检查台不发起网络请求、"
                f"不读取本地文件",
                line, col,
            )

    def on_entity_decl(name, is_parameter, value, base, system_id, public_id, notation):
        nonlocal entity_decls, declared_entity_bytes
        entity_decls += 1
        if entity_decls > lim["max_entity_decls"]:
            abort("max_entity_decls", f"实体声明数量超限：超过 {lim['max_entity_decls']} 个")
        line, col = pos()
        if is_parameter:
            diag(
                SEV_BLOCKED, "parameter_entity",
                f"参数实体 '%{name};' 已阻止：参数实体常用于外部 DTD 攻击，一律不展开",
                line, col,
            )
            return
        if system_id:
            diag(
                SEV_BLOCKED, "external_entity",
                f"外部实体 '&{name};'（{system_id}）已拒绝加载：不读取本地文件、"
                f"不发起网络请求，引用处将被跳过",
                line, col,
            )
            return
        if notation:
            diag(
                SEV_BLOCKED, "unparsed_entity",
                f"未解析实体 '&{name};'（NDATA {notation}）已阻止：可能触发外部资源读取",
                line, col,
            )
            return
        if value is not None:
            declared_entity_bytes += len(value)
            if declared_entity_bytes > lim["max_declared_entity_bytes"]:
                abort(
                    "max_declared_entity_bytes",
                    f"实体声明总大小超限：超过 {lim['max_declared_entity_bytes']} 字符",
                )
            diag(
                SEV_INFO, "internal_entity",
                f"内部实体 '&{name};' 已声明（{len(value)} 字符），将在限额内展开",
                line, col,
            )

    def on_external_entity_ref(context, base, system_id, public_id):
        line, col = pos()
        diag(
            SEV_BLOCKED, "external_entity_ref",
            f"外部实体引用（{system_id}）已拒绝：安全检查台不读取本地文件、"
            f"不发起网络请求，该引用已跳过",
            line, col,
        )
        return 1  # 告诉 expat 跳过该外部实体，继续解析（expat 本身也不会去抓取）

    parser.StartElementHandler = on_start_element
    parser.EndElementHandler = on_end_element
    parser.CharacterDataHandler = on_char_data
    parser.CommentHandler = on_comment
    parser.ProcessingInstructionHandler = on_pi
    parser.StartCdataSectionHandler = on_start_cdata
    parser.EndCdataSectionHandler = on_end_cdata
    parser.StartNamespaceDeclHandler = on_start_ns
    parser.XmlDeclHandler = on_xml_decl
    parser.StartDoctypeDeclHandler = on_start_doctype
    parser.EntityDeclHandler = on_entity_decl
    parser.ExternalEntityRefHandler = on_external_entity_ref

    status = "ok"
    try:
        parser.Parse(raw, True)
    except _Abort as exc:
        line, col = pos()
        diag(SEV_LIMIT, exc.code, exc.message, line, col)
        status = "limited"
    except expat.ExpatError as exc:
        message = str(exc)
        # expat 2.4+ 自带的放大倍数保护，作为我们的兜底防线。
        if "amplification" in message:
            diag(
                SEV_LIMIT, "entity_expansion_expat",
                f"实体展开超限（解析器兜底保护）：{message}",
                getattr(exc, "lineno", None), getattr(exc, "offset", None),
            )
            status = "limited"
        else:
            diag(
                SEV_ERROR, "wellformedness",
                f"格式错误：{message}",
                getattr(exc, "lineno", None), getattr(exc, "offset", None),
            )
            status = "error"

    if status == "ok" and any(d["severity"] == SEV_BLOCKED for d in diagnostics):
        status = "blocked"

    stats = {
        "elements": elem_count,
        "max_depth": max_depth_seen,
        "text_chars": text_chars,
        "entity_decls": entity_decls,
    }
    return _result(status, diagnostics, root, started, input_bytes, lim, stats)


def _result(status, diagnostics, tree, started, input_bytes, limits, stats=None):
    return {
        "status": status,
        "diagnostics": diagnostics,
        "tree": tree,
        "stats": stats or {"elements": 0, "max_depth": 0, "text_chars": 0, "entity_decls": 0},
        "input_bytes": input_bytes,
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
        "limits": limits,
    }
