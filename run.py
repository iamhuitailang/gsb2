"""开发服务器入口：python run.py"""
from app import create_app
from app.config import HOST, PORT

app = create_app()

if __name__ == "__main__":
    # threaded=True：领取过程中页面仍可轮询日志
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
