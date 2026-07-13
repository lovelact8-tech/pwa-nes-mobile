# PWA NES Mobile

手机版 NES PWA 模拟器。

## 运行

1. 解压项目。
2. 双击 `run-mac.command`。
3. iPhone 与 Mac 连接同一个 WiFi。
4. 用 iPhone Safari 打开终端显示的地址，例如 `http://192.168.20.164:5173`。
5. 选择你自己的 `.nes` 文件。

## iPhone 建议

- Safari 浏览器底部地址栏会占空间，建议打开后点“分享 → 添加到主屏幕”。
- 从主屏幕图标打开后，按钮区域会更大，误触更少。
- 声音如果没出来，点右上角“开声/有声”按钮，或点一下任意游戏按键。

## 说明

- 本项目不包含任何 ROM。
- 请使用你自己合法拥有、自制或开源授权的 `.nes` 文件。
- 这一版已优化手机按键和 iPhone 本地网页声音。
- 切到后台或来电打断时会自动释放按键并清空旧音频，减少卡键和爆音。
- 联机使用主机权威帧和 4 帧输入缓冲，按键会在两端同一模拟帧执行；完整状态仅在连接、换游戏或读档时同步，并通过轻量帧时钟修正漂移。
- “创建直连房间”使用 PeerJS/WebRTC，适合同一局域网或能够 NAT 穿透的网络。
- “创建跨网房间”使用项目自带的私有 WebSocket 中继，适合家庭宽带、5G 和异地网络。邀请链接会自动携带传输方式，2P 直接打开或粘贴链接即可。
- 虚拟手柄可在“设置 → 调整按键位置”中拖动；选中按键后可用 −/+ 或双指缩放，也可以直接选择全局大小和透明度。
- 横屏、竖屏手柄布局分别保存，旋转屏幕或进入放大模式时不会互相覆盖。

## 部署跨网中继

中继默认只监听服务器本机的 `127.0.0.1:8787`，建议用 Caddy 提供 HTTPS/WSS：

```bash
npm ci
sudo cp relay-server/pwa-nes-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pwa-nes-relay
```

把 `relay-server/Caddyfile.example` 中的域名改成自己的域名并启动 Caddy。服务器需要开放 TCP 80/443，不需要开放 8787。健康检查地址为 `https://你的域名/health`。

在 GitHub 仓库 `Settings → Secrets and variables → Actions → Variables` 新建：

```text
VITE_RELAY_URL=https://你的中继域名
```

然后重新运行 GitHub Pages 工作流。中继仅接受 `https://lovelact8-tech.github.io` 来源，每个房间最多 1P 和 2P 各一人，并限制单 IP 连接数、消息大小和传输速率。
