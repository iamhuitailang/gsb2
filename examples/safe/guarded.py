"""Safe counterparts: every dangerous operation here is properly guarded."""

import hashlib
import os
import sqlite3
import subprocess
from pathlib import Path

import yaml


ALLOWED_HOSTS = {"alpha.internal", "beta.internal"}


def ping_host_safe(request):
    host = request.args.get("host")
    if host not in ALLOWED_HOSTS:
        raise ValueError("host not allowed")
    # Safe: constant argv[0], shell=False, value validated against allow-list.
    subprocess.run(["ping", "-c", "1", host], shell=False)


def sql_safe(request, conn):
    name = request.args.get("name")
    # Safe: parameterised query.
    conn.execute("SELECT * FROM users WHERE name = ?", (name,))


def sql_quoted_safe(request, conn):
    name = request.args.get("name")
    quoted = conn.escape_string(name)
    # SQL-specific escaping: effective for SQL.
    conn.execute("SELECT * FROM users WHERE name = '" + quoted + "'")


def code_safe(request):
    from ast import literal_eval

    payload = request.args.get("payload")
    # Safe: literal_eval does not execute code.
    return literal_eval(payload)


def code_allowlist_safe(request):
    handlers = {"sum": sum, "max": max}
    action = request.args.get("action")
    # Safe: name is looked up in a fixed mapping, not eval'd.
    handler = handlers.get(action)
    if handler is None:
        raise ValueError("unknown action")
    return handler([1, 2, 3])


def yaml_safe(request):
    document = request.data
    # Safe: safe_load builds only plain data.
    return yaml.safe_load(document)


def path_safe(request):
    name = os.path.basename(request.args.get("file", ""))
    if not name:
        raise ValueError("missing file")
    # Safe: basename strips directory components.
    return open(os.path.join("/srv/data", name)).read()


def path_resolved_safe(request):
    root = Path("/srv/data").resolve()
    candidate = (root / request.args["file"]).resolve()
    if root not in candidate.parents:
        raise ValueError("outside root")
    # Safe: resolved path is checked to stay under the root.
    return open(candidate).read()


def path_constant_safe(request):
    # Safe: the path is a constant; request data does not reach it.
    request.args.get("ignored")
    return open("/srv/data/fixed.txt").read()


def subprocess_safe(request):
    count = int(request.args.get("count", "1"))
    # Safe: int() removes string payloads, list form avoids the shell.
    subprocess.run(["head", "-n", str(count), "/tmp/log"], shell=False)


def shell_quote_safe(request):
    import shlex

    host = shlex.quote(request.args.get("host", ""))
    # Safe for command sinks: shlex.quote escapes shell metacharacters.
    os.system("ping -c 1 " + host)


def attribute_safe(request):
    data = {"a": 1, "b": 2}
    key = request.args.get("key")
    if key not in {"a", "b"}:
        raise KeyError("unknown key")
    # Safe: key validated against a fixed allow-list before indexing.
    return data[key]
