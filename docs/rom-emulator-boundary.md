# 模拟器与游戏 ROM 的边界

## 模拟器负责什么

- 执行 CPU、PPU、APU、手柄与标准 Mapper。
- `src/emulator/rom-compat.js` 提供通用 Mapper 198 扩展 RAM、分 bank CHR-RAM 和 PRG bank 线路。
- 带 `M198` iNES 硬件标记的 ROM 可以使用固定的扩展 bank 协议；协议状态会进入普通存档和联机回滚状态。
- 模拟器不知道游戏剧情、人物、队伍、地图或开局位置。

## ROM 负责什么

- 标题页、开局入口、剧情、人物、编队、地图、战斗与游戏存档。
- 《汉室新章》v0.5 在 ROM 内包含 6502 启动代码和新章起点数据。第一次确认后由卡带自己恢复 RAM、CHR-RAM、PPU 和队伍状态。
- ROM 在进入私人扩展区前写入 `$5FF0=$4D, $5FF1=$98`，退出时写入 `$5FF0=$00, $5FF1=$00`。
- 后续修改文字、人物、道具、地图或战斗时，只重新构建 `.nes`，不修改模拟器。

## 兼容性例外

只有 ROM 改用了另一种 Mapper 或新增了原硬件不存在的能力，才需要为模拟器增加一次新的通用硬件实现。普通内容更新不属于模拟器修改。

## 回归测试

- `npm run modules:test`：通用 M198 标记、bank 协议、序列化和普通 ROM 隔离。
- `npm run native-cartridge:test`：标题冷启动、ROM 原生新章启动、序章完成、恢复普通 Mapper 模式和继续运行。
- `npm run netplay:test`：双实例确定性、回滚和跨采样率同步。
