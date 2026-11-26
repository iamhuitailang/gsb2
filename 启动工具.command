#!/bin/bash
# 双击本文件即可在本地启动「灵动标题工坊」并打开浏览器。
# 使用 tools/studio_server.py：除了静态托管，还支持一键调用本机 ffmpeg
# 合成带透明通道的 WebM / ProRes MOV（没有 ffmpeg 也能正常使用 PNG 序列导出）。
# 关闭这个终端窗口即停止本地服务。
cd "$(dirname "$0")"
PORT=8123
URL="http://127.0.0.1:${PORT}/"

echo "================================================"
echo "  灵动标题工坊 Motion Title Studio"
echo "  本地地址: $URL"
echo "  关闭此窗口即可停止服务"
echo "================================================"

( sleep 1.4; open "$URL" ) &

if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/studio_server.py "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python tools/studio_server.py "$PORT"
else
  echo "未找到 python3，请改用任意静态服务器，例如 npx serve ."
  read -r -p "按回车键关闭..."
fi
