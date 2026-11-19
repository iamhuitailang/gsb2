"""Risky examples: untrusted input reaches dangerous operations.

This file intentionally contains vulnerabilities used as scanner fixtures.  It
is never imported by the tool or the test suite.
"""

import hashlib
import os
import pickle
import sqlite3
import subprocess

import yaml


# --- TS001: command execution ------------------------------------------------

def run_report(host):
    # Direct source -> sink.
    os.system("ping -c 1 " + host)


def run_upload(request):
    name = request.args.get("name")
    # Source -> local variable -> sink with shell=True.
    subprocess.run(f"tar -czf /tmp/{name}.tgz uploads/", shell=True)


def run_via_helper(request):
    command = request.form["cmd"]
    _execute_command(command)


def _execute_command(command):
    # Interprocedural: taint flows in through the parameter.
    os.popen(command)


def run_list_form_safe(request):
    name = request.args["file"]
    # Safe fixture: argv[0] is constant, list form + shell=False.
    subprocess.run(["ls", "-l", name], shell=False)


def run_constant_safe(request):
    request.args.get("unused")
    subprocess.run(["ls", "-l", "/tmp"], shell=False)


# --- TS002: SQL --------------------------------------------------------------

def lookup_user(request, conn):
    user_id = request.args.get("id")
    cursor = conn.cursor()
    # Direct source into a formatted query.
    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")


def lookup_by_name(request, conn):
    name = request.args.get("name")
    query = _build_query(name)
    conn.cursor().execute(query)


def _build_query(name):
    # Taint crosses a function boundary via a return value.
    return "SELECT * FROM users WHERE name = '" + name + "'"


def lookup_safe(request, conn):
    name = request.args.get("name")
    # Safe fixture: parameterised query; the parameter tuple is not a sink arg.
    conn.cursor().execute("SELECT * FROM users WHERE name = ?", (name,))


def lookup_int_safe(request, conn):
    user_id = int(request.args.get("id"))
    # Safe fixture: int() makes the value non-string for every sink kind.
    conn.cursor().execute(f"SELECT * FROM users WHERE id = {user_id}")


# --- TS003: dynamic code -----------------------------------------------------

def calculate(request):
    expression = request.args.get("expr")
    return eval(expression)


def dispatch(request):
    module_name = request.form.get("module")
    # Dynamic import reachable from request data.
    return __import__(module_name)


def calculate_safe(request):
    expression = request.args.get("expr")
    # Safe fixture: literal_eval only accepts literals, never code.
    from ast import literal_eval

    return literal_eval(expression)


# --- TS004: deserialization --------------------------------------------------

def load_session(request):
    payload = request.cookies.get("session")
    return pickle.loads(payload)


def load_settings(request):
    document = request.data
    return yaml.load(document, Loader=yaml.FullLoader)


def load_user_json(request):
    # Safe fixture: json is a pure-data format.
    import json

    return json.loads(request.data)


# --- TS005: file paths -------------------------------------------------------

def download(request):
    filename = request.args.get("file")
    with open(os.path.join("/srv/data", filename)) as handle:
        return handle.read()


def delete_upload(request):
    path = request.form["path"]
    os.remove(path)


def download_safe(request):
    from werkzeug.utils import secure_filename

    filename = secure_filename(request.args["file"])
    # Safe fixture: secure_filename removes directory components.
    return open(os.path.join("/srv/data", filename)).read()


def download_reconstructed(request):
    # Not tainted: no user input reaches the path.
    return open("/srv/data/static.txt").read()
