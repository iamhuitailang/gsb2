"""Risky examples that need more than one project function to be visible."""

import os
import sqlite3
import subprocess


def handle_request(request, db):
    user_id = request.args.get("id")
    _layer_one(user_id, db)


def _layer_one(user_id, db):
    query = _layer_two(user_id)
    db.cursor().execute(query)


def _layer_two(user_id):
    return "SELECT * FROM accounts WHERE id = " + user_id


def handler_shell(request):
    value = request.form["host"]
    _wrap_subprocess(value)


def _wrap_subprocess(value):
    _really_run(value)


def _really_run(value):
    subprocess.check_output(f"nslookup {value}", shell=True)


class ReportService:
    """Method-to-method flow through instance state and attributes."""

    def __init__(self, db):
        self.db = db

    def handle(self, request):
        name = request.args.get("name")
        self._run(name)

    def _run(self, name):
        self.db.cursor().execute(f"SELECT * FROM reports WHERE name = '{name}'")


class BaseLoader:
    def load(self, path):
        return open(path).read()


class UserLoader(BaseLoader):
    def load_path(self, request):
        requested = request.args["path"]
        # Inherited method: taint flows through the base class.
        return self.load(requested)


def returns_source(request):
    return request.args.get("q")


def consumes_source():
    query = returns_source()
    os.system("grep " + query + " /tmp/log")


def sanitized_return(request):
    return int(request.args.get("id"))


def consumes_sanitized():
    value = sanitized_return()
    # Safe fixture: sanitisation happened inside the callee and is preserved.
    os.system(f"echo {value}")
