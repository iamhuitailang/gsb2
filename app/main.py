"""启动入口：python -m app.main"""
from __future__ import annotations

from .config import Config
from .http_server import build_server


def main() -> None:
    config = Config()
    httpd, service = build_server(config)
    try:
        print(
            f"本地账号登录服务已启动: http://{config.host}:{config.port}\n"
            f"账号上限 {config.account_limit} 次 / {config.account_window_seconds} 秒；"
            f"来源上限 {config.source_limit} 次 / {config.source_window_seconds} 秒\n"
            f"演示账号: jia / jia-pass-123，yi / yi-pass-123\n"
            "按 Ctrl+C 停止。"
        )
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务……")
    finally:
        httpd.server_close()
        service.close()


if __name__ == "__main__":
    main()
