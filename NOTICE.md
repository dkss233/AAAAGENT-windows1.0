# 来源与改动说明 / Origin and Modifications

本文件说明本仓库与原始项目的关系，以及相对于原始项目所做的修改。
许可第 4 条要求使用与分发时保留署名并说明修改，本文件即为此用途。

## 原始项目 / Origin

- 项目：**AAAAGENT**
- 作者：phoiex 及项目贡献者
- 来源：<https://github.com/phoiex/AAAAGENT>
- 本仓库基于其 **Windows 部分**（`windows/` 子目录），版本 `0.3.0-dev.1`（源码候选版）

原始项目的原创内容适用 [LICENSE](LICENSE)（AAAAGENT 非商业使用及署名许可 1.0）。
第三方内容的许可与署名要求见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本仓库的修改 / Modifications

由 **dkss233**（<https://github.com/dkss233>）修改，2026-10。

**修改性质**：新增功能与缺陷修复，不改变原始项目的整体架构与许可条款。
**以下内容均为修改后的版本，不代表原作者观点，原作者未对本仓库背书。**

### 新增功能

| 功能 | 涉及文件（主要） |
|---|---|
| 情绪 → 表情映射（控制台可视化配置） | `management/presentation.ts`、`management/ui/presentation-view.mjs`、`desktop/cubism-renderer.mjs` |
| 表情「是否持续启用该表情」开关 | `management/ui/presentation-view.mjs`、`desktop/cubism-renderer.mjs` |
| 控制台预览界面缩放（0.2×–8×） | `management/ui/presentation-view.mjs`、`desktop/presentation-preview.mjs` |
| 注视鼠标（👁，眼/头/身体跟随，窗口外仍跟随） | `desktop/interaction-motion.mjs`、`desktop/cubism-renderer.mjs`、`desktop/electron/main.mjs`、`desktop/electron/preload.cjs` |
| Harness 主机按需启动与退出自动停止 | `harness/on-demand.ts`、`management/bootstrap.ts`、`management/task-routes.ts`、`management/ui/tasks-view.mjs` |
| Windows 一键启动与换模型工具 | `../tools/aaaagent-*.mjs`（本仓库根 `tools/` 之外，见下） |

### 缺陷修复

| 缺陷 | 说明 |
|---|---|
| 情绪映射不生效 | 对话模型返回字符串 `"null"` 的 presetId 覆盖了情绪映射；并在命名预设不可用时回退到情绪映射 |
| 表情参数被每帧重置 | 表情参数未登记，逐帧重置覆盖；改为动态登记 |
| 换模型后控制台打不开 | 失效策略导致后端启动崩溃；改为丢弃而非抛错 |
| 看不到桌宠的回复 | 历史读取要求助手回复"引用"用户消息，而实际为空数组，导致全部回复被丢弃 |
| 批处理文件打不开 | `.cmd` 用 LF 换行；改为 CRLF |
| 中文路径乱码 | PowerShell 输出经管道变乱码；改为 Base64(UTF-8) 传输 |
| 外观标记无法持续生效 | 一次性写入被逐帧重置覆盖；改为每帧重新应用 |
| 启动时弹出 cmd 窗口 | 经 `cmd /c start` 启动；改为直接启动 `node`，不创建控制台会话 |
| 界面消息被静默丢弃 | `preload.cjs` 方法白名单未登记新消息名 |

完整的改动过程、根因分析与验证记录见 [桌宠开发日志.md](桌宠开发日志.md)。

### 未修改的部分

- 原始项目的代码主体、架构、测试框架与第三方依赖
- `LICENSE` 文本逐字采用原始项目的许可，未作改动
- 第三方组件（Live2D Cubism SDK、T3、视频桌宠素材等）未作修改

## 未随仓库分发的内容 / Not Redistributed

按原始项目 `THIRD_PARTY_NOTICES.md` 的要求，以下内容**不随本仓库分发**，运行者需自行准备：

- **Live2D 模型**：`code/desktop-pet/desktop/assets/jellyfish/`、`.../local-model/`
  完整私有资源目录（`.moc3`、贴图、物理、模型配置、表情、动作）
- **Cubism SDK**：`code/desktop-pet/desktop/vendor/`
- **T3 字体**：字形来源无法确认再分发条款的字体文件
- **私人素材**：参考音频、密钥、账号状态、个人数据库、本地审核报告
- **构建与本地数据**：`node_modules/`、`dist/`、`build/`、`artifacts/`、`.local/`

详见 [.gitignore](.gitignore) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
