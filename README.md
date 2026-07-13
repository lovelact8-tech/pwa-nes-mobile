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
sudo cp relay-server/pwa-nes-relay.env.example /etc/pwa-nes-relay.env
sudo chmod 600 /etc/pwa-nes-relay.env
sudo cp relay-server/pwa-nes-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pwa-nes-relay
```

部署前编辑 `/etc/pwa-nes-relay.env`：`RELAY_ACCESS_KEY` 设置为只有你知道的至少 16 位访问码，`RELAY_TOKEN_SECRET` 使用独立的至少 32 位随机字符串。这两个值只保存在 VPS，禁止提交到 GitHub。

把 `relay-server/Caddyfile.example` 中的域名改成自己的域名并启动 Caddy。服务器需要开放 TCP 80/443，不需要开放 8787。健康检查地址为 `https://你的域名/health`。

在 GitHub 仓库 `Settings → Secrets and variables → Actions → Variables` 新建：

```text
VITE_RELAY_URL=https://你的中继域名
```

然后重新运行 GitHub Pages 工作流。创建跨网房间时，1P 必须输入私人访问码；服务器验证后只签发当前房间、当前角色可用且两小时后过期的票据。访问码不会保存到网页或邀请链接，2P 只能使用邀请票据加入该房间，不能创建新房间。

中继还会限制网页来源、每房间人数、单 IP 连接数、消息大小、传输速率和访问码尝试次数。
