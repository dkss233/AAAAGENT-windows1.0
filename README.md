# AAAAGENT Windows 0.3.0-dev.1

> ## 授权与署名 / License and attribution
>
> 本项目源自 **AAAAGENT** —— <https://github.com/phoiex/AAAAGENT>（作者：phoiex 及项目贡献者）。
> 本仓库是其 Windows 部分的**修改版本**，由 [dkss233](https://github.com/dkss233) 修改（2026-10）。
>
> 适用许可：**[AAAAGENT 非商业使用及署名许可 1.0](LICENSE)** —— 允许非商业使用，
> **禁止任何形式的商业用途**，使用时须署名并保留来源。这不是 MIT / Apache 或 OSI 批准的开源许可。
>
> 具体修改内容见 **[来源与改动说明](NOTICE.md)**；完整的改动过程与验证记录见
> **[桌宠开发日志（公开版）](桌宠开发日志-公开版.md)**。
>
> 本仓库的修改不代表原作者观点，**原作者未对本仓库背书**。
> 原始项目版权、来源与第三方声明均予保留，详见 [第三方来源与许可](THIRD_PARTY_NOTICES.md)。
>
> This is a **modified version** of AAAAGENT (<https://github.com/phoiex/AAAAGENT>).
> Licensed under the AAAAGENT Noncommercial and Attribution License 1.0 — noncommercial use only,
> attribution required. Modifications are listed in [NOTICE.md](NOTICE.md).
> Not endorsed by the original authors.

Windows 源码候选版，**不是稳定版，也没有签名安装包**。本版接入视频桌宠 / Live2D 切换、独立 T3 工作台、三种 ASR、三种 TTS，以及默认关闭的 Ollama 本地前台对话。2026-10-10 的分阶段测试有通过项，也有未解决的模型质量与后台记忆问题。

[English](README.en.md) · [项目首页](https://github.com/phoiex/AAAAGENT) · [第三方来源与许可](THIRD_PARTY_NOTICES.md) · [来源与改动说明](NOTICE.md) · [许可](LICENSE)

Windows 使用独立的 `windows/code/desktop-pet/` 源码、Electron 窗口和 Node.js 后端。Mac 入口在项目首页；不要混用两个平台的 `node_modules`、二进制、配置路径或运行指纹。

## 开始使用

> **下载的源码不能直接双击 `.cmd` 运行。** 仓库不含 `dist/`、`node_modules/` 等构建产物，必须先安装依赖并编译；未编译时启动器会直接列出缺少的产物和要执行的命令。完整步骤见 [安装与配置](docs/SETUP.md)。

准备 Windows x64、Node.js 22.12 或更高版本，以及有权使用的桌宠素材与所需 SDK。从仓库根目录运行：

```powershell
cd windows/code/desktop-pet
npm.cmd ci
npm.cmd run build
npm.cmd run build:desktop
```

首次配置用 `npm.cmd run configure-local`（打开设置网页），之后用 `npm.cmd start` 启动桌宠。引擎运行时（`artifacts/runtime`，约 1.3 GB）不随仓库提供，只有让桌宠执行 DSH 任务时才需要，对话、语音、表情与注视都不依赖它。

也可使用 `windows/Start-Windows.cmd`。预览需要自行准备兼容资源，文字只做离线回显，不等于真实模型对话。实际服务配置与资源位置见 [Windows 安装指南](README-WINDOWS.md)。

编译后，`npm.cmd run configure-local` 打开首次配置网页；配置自己的服务账户和外部凭据，完成激活后用 `npm.cmd start`。云端服务可能产生费用。本地语音和对话均为显式选择，配置步骤分别见 [本地 ASR/TTS](local-models/README.md) 与 [本地 LLM](docs/LOCAL-LLM.md)。

## 本次验证范围

- **桌面与工作台：** 视频 / Live2D 切换及 Electron 基本交互已检查。视频桌宠基于 PC2005-cloud 的 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：代码采用 MIT，动画、提示词和源视频遵循上游非商业条款，媒体不随源码分发。Codex 与 DeepSeek Harness 经 T3 各完成两轮同会话文件任务；Codex 另完成官方 app-server 同会话恢复。这不证明原生桌面客户端双向同步或完整桌宠 UI 的全部任务路径。
- **语音：** SenseVoice Small、Paraformer、Whisper-small，以及 GPT-SoVITS、Kokoro、Qwen3-TTS 均经应用适配器实际推理；9 段合成样音、27 次交叉转写和 3 次官方录音识别完成。仍有转写误差；GPT/Qwen 使用官方权重与合成参考，未验证个人微调音色、实体设备和长期负载。
- **本地对话：** Qwen3.5 4B 的结构化回复与表情链路可用，但两次把 `(17 * 23) + 5` 答成 404，正确值为 396；上下文复述也出现失败。9B 只下载和准备，资源检查未放行，随后按用户要求取消，未加载、未推理。
- **后台记忆：** 一次完整后端试验出现前台准入 `none` 与云端严格记忆 `forget` 分歧，同轮助手来源被时间边界拒绝。保护未放宽，该轮完整链路不能算通过。前台本地不代表后台记忆、准入、摘要或其他组件离线。

测量条件、延迟及限制见 [本次 Windows 验证](docs/WINDOWS-20261010.md) 和 [本地 LLM 结果](docs/LOCAL-LLM.md)。回归测试通过不能替代真实模型质量验收。

## 文档与分发范围

- [安装、升级和任务派发](README-WINDOWS.md)
- [密钥、模型与音色配置](docs/SETUP.md)
- [记忆、旧聊天导入与情绪记录](docs/MEMORY.md)
- [Windows 更新记录](CHANGELOG-WINDOWS.md)
- [第三方桌宠资源、上游项目与许可说明](THIRD_PARTY_NOTICES.md)

模型权重、私人视频 / Live2D 素材、参考音频、密钥、账号状态、个人数据库和本地审核报告不随仓库分发。SDK、引擎及模型依赖按各自许可另行准备；示例路径不表示资源已随仓库提供。

项目原创部分的条款见 [LICENSE](../LICENSE)；第三方内容适用其各自许可，须保留原项目引用和署名。项目来源：[AAAAGENT](https://github.com/phoiex/AAAAGENT)。
