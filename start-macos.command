#!/bin/zsh
# Double-click this file in Finder to start the local tool on macOS.
cd "$(dirname "$0")"
echo "Starting WAV sample-level split/restore tool..."
echo "Open http://127.0.0.1:8765 in your browser if it does not open automatically."
( sleep 1; open "http://127.0.0.1:8765" ) &
exec python3 wav_tool.py serve --host 127.0.0.1 --port 8765
