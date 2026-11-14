"""Flask 应用工厂：资料站与领取应用共用一个进程。"""
from flask import Flask, redirect, url_for

from . import config, db, seed
from .inbox import bp as inbox_bp
from .portal import bp as portal_bp


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["JSON_AS_ASCII"] = False

    # 初始化表结构；资料目录为空时自动播种演示数据
    conn = db.get_conn()
    try:
        db.init_schema(conn)
        count = conn.execute("SELECT COUNT(*) AS n FROM reports").fetchone()["n"]
    finally:
        conn.close()
    if count == 0:
        seed.seed()

    app.register_blueprint(portal_bp)
    app.register_blueprint(inbox_bp)

    @app.get("/")
    def home():
        return redirect(url_for("inbox.index"))

    return app
