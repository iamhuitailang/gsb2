"""与 SQL 无关的字符串拼接，不应产生任何发现。"""

from flask import request


def greet():
    name = request.args.get("name")
    # 普通字符串拼接，不接触数据库
    message = "hello, " + name
    return message


def build_path():
    filename = request.form.get("filename")
    path = "/var/data/" + filename
    return path


def log_message():
    user = request.json.get("user")
    print("user logged in: %s" % user)


def pure_formatting():
    keyword = request.args.get("q")
    title = "Search results for {}".format(keyword)
    summary = f"{keyword} matched {len(keyword or '')} chars"
    return title, summary
