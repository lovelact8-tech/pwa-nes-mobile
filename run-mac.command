#!/bin/bash
cd "$(dirname "$0")"
echo "正在启动 PWA NES Mobile..."
echo ""
IP=$(ipconfig getifaddr en0 2>/dev/null)
if [ -z "$IP" ]; then
  IP=$(ipconfig getifaddr en1 2>/dev/null)
fi
if [ -z "$IP" ]; then
  IP="你的Mac局域网IP"
fi
echo "电脑本机打开: http://localhost:5173"
echo "iPhone Safari 打开: http://$IP:5173"
echo ""
echo "按 Ctrl+C 可以停止服务。"
python3 -m http.server 5173 --directory dist
