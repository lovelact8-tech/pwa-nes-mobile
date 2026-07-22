# PWA NES Mobile 架构说明

## 入口与依赖方向

`src/main.js` 是应用编排入口，只负责把模拟器、输入、界面、存储和联机模块连接起来。新功能应优先放入对应模块，不要继续向入口堆积独立实现。

依赖方向保持为：

```text
main.js
├── emulator/*        模拟器适配、音视频输出
├── input/*           虚拟手柄和布局
├── netplay/*         联机协议、回滚、串流、延迟策略
├── storage/*         本地存储键和存档基础设施
├── ui/*              DOM、图标、按钮和弹窗
└── pwa/*             Service Worker 注册
```

底层模块不能反向导入 `main.js`。需要访问运行状态时，通过创建控制器时传入的回调读取，避免隐藏的全局变量。

## 模块职责

| 问题或功能 | 首先定位 | 职责 |
| --- | --- | --- |
| 应用启动、ROM切换、帧循环 | `src/main.js` | 创建 NES、组织各控制器、回滚联机总编排 |
| 声音卡顿、采样率、声音开关 | `src/emulator/audio.js` | AudioContext、缓冲区、44.1/48kHz重采样、串流音轨 |
| 特殊ROM黑屏或Mapper兼容 | `src/emulator/rom-compat.js` | 按ROM特征安装兼容层 |
| M198 扩展卡带 | `src/emulator/rom-compat.js` | 只实现扩展RAM、CHR-RAM和PRG bank协议；不识别剧情、人物或开局 |
| 旧续篇ROM兼容（只读遗留） | `src/emulator/tunshi-postgame-*.js` | 仅让v0.4及更旧测试版可迁移；v0.5起不再依赖这些网页运行时 |
| 分辨率、FPS帧常量 | `src/emulator/constants.js` | 模拟器屏幕和帧时序常量 |
| 1×/2×/4×/6×/8×加速 | `src/emulator/playback-speed.js` | 档位校验、记忆设置、联机1×锁定和速度界面状态 |
| A/B/AB、方向盘、键盘、连续按键 | `src/input/controller.js` | 汇总触摸和键盘输入并提供本地视觉反馈 |
| 蓝牙/USB实体手柄 | `src/input/gamepad.js` | Gamepad API设备发现、标准按键映射和轮询输入 |
| 手柄位置、大小、透明度、横竖屏布局 | `src/input/control-layout.js` | 独立保存和编辑两套布局 |
| 回滚状态保存、恢复、哈希差异 | `src/netplay/state.js` | 确定性状态和跨设备一致性 |
| 输入消息格式 | `src/netplay/input.js` | 输入位图编码与解码 |
| 2P延迟、缓冲帧策略 | `src/netplay/latency-policy.js` | 根据RTT/抖动选择预测或缓冲方案 |
| 联机阈值和超时 | `src/netplay/constants.js` | RTT、回滚窗口、心跳等常量 |
| 1P权威画面/WebRTC串流 | `src/netplay/authoritative-stream.js` | 视频音频轨道、DataChannel输入、ICE和统计 |
| 中继地址选择错误 | `src/netplay/relay-url.js` | URL参数、部署变量、本地配置的优先级 |
| JSON存档导入格式或校验 | `src/storage/state-file.js` | 兼容 raw jsnes，生成版本化 state/runtime 封装并校验可选 ROM SHA/长度，不操作模拟器 |
| 按钮图标或文字 | `src/ui/buttons.js`、`src/ui/icons.js` | 按钮标签和SVG图标水合 |
| 弹窗开关问题 | `src/ui/dialogs.js` | 菜单和设置弹窗行为 |
| 页面元素找不到 | `src/ui/dom.js` | 所有DOM引用的唯一入口 |
| PWA没有更新 | `src/pwa/register.js`、`public/sw.js` | 注册Service Worker和缓存版本 |

## 联机核心仍在 main.js 的原因

回滚模式必须在同一帧边界内协调 NES 执行、输入排序、快照、时钟和状态校验。当前将这部分保留在入口编排层，避免为了拆文件而引入异步顺序变化。后续继续拆分时，应优先建立一个显式的 `RollbackSession` 状态对象，再搬移逻辑，不能只复制全局变量到另一个大文件。

## 修改规范

1. 新功能先判断所属模块，再由 `main.js` 注入必要回调。
2. 模块内部状态使用工厂函数闭包保存，不增加 `window` 全局变量。
3. ROM加载后兼容层和状态恢复路径必须保持一致。
4. 输入延迟策略修改后必须运行 `npm run latency:test` 和 `npm run netplay:test`。
5. ROM兼容修改必须运行 `npm run modules:test` 和 `npm run rom-compat:test`。
6. 发布前运行 `npm run build`，并递增 `public/sw.js` 缓存版本。
7. 实体手柄或加速功能修改后运行 `npm run controls:test`；联机始终保持1×，不得把加速档位带入回滚时间线。

## 《吞食天地2：汉室新章》兼容边界

v0.5 是自包含卡带：标题、首次确认、新章初始化、剧情数据和完成后返回都在 `.nes` 内。模拟器只看 iNES 头的 `M198` 硬件标记并提供固定的 Mapper 198 扩展协议，不读取游戏名、剧情指纹或网页检查点。以后修改文字、人物、地图、战斗和开局，只重建 ROM。

2 MiB ROM 必须让 `$FE/$FF` 保持为物理固定 bank。它们不是写入 MMC3 可切换寄存器的值，不能套用 Mapper 198 的 `$50-$FF` 别名掩码；错误归一化会把标题代码映射到 `$4E/$4F`，造成有声音但灰屏。卡带需要访问物理扩展 bank 时，写 `$5FF0=$4D`、`$5FF1=$98`；退出时写两个零。协议状态进入 Mapper JSON，因此本地存档和联机回滚使用同一状态。

640KB/1MB 同能网底版仍保留严格指纹兼容，防止影响普通 Mapper 4 ROM。旧 v0.4 续篇的网页运行时仅为历史文件保留，新 v0.5 明确排除该运行时；新功能不得继续加入旧适配器。更详细的边界见 `docs/rom-emulator-boundary.md`。
