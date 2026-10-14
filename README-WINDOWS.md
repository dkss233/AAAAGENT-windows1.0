# Windows 0.3.0-dev.1 安装与运行

这是源码候选版，没有签名安装包；真实模型和完整后端仍有已知失败。请先阅读 [验证范围](docs/WINDOWS-20261010.md)、[本地 LLM 的失败记录](docs/LOCAL-LLM.md) 及 [第三方来源与许可](THIRD_PARTY_NOTICES.md)。Mac 使用项目根目录的对应入口，Windows 使用独立 `windows/` 目录。

## 1. 环境与资源

- Windows x64；Node.js 22.12 或更高版本及 npm。Windows ARM64 未验证。
- 能访问所需 npm 包及上游发行资源。Electron、SQLite 和唤醒依赖需要 Windows 二进制，不能复制 Mac / WSL 的 `node_modules`。
- 自行准备有权使用的 Live2D / 视频桌宠素材、相应映射与 SDK。仓库不包含私人素材、模型权重、参考音频、服务密钥、账号状态或个人数据库。

Live2D 资源目录如下，具体模型需保留其文件引用、动作、表情和授权声明；放入文件不等于任意模型都已适配：

```text
windows/code/desktop-pet/desktop/
  assets/local-model/pet.model3.json
  assets/local-model/presets.json
  assets/local-model/parameter-map.json
  assets/local-model/…模型引用的其他文件
  vendor/cubism/Core/live2dcubismcore.min.js
  vendor/cubism/Framework/src/…
```

视频模式同样需要匹配的本地素材和动作目录，相关上游为 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。本次验证使用的私人视频 / Live2D 资源不随源码分发，来源和署名按 [第三方说明](THIRD_PARTY_NOTICES.md) 保留。不要用旧 Mac 源码、运行包或激活指纹覆盖 Windows 目录。

公开源码在没有 Live2D SDK 或预设目录时仍可编译，桌面文字界面和已安装的视频桌宠不依赖这些资源；选择 Live2D 或管理页的角色预览会明确提示资源未安装，不会显示替代模型或报告加载成功。补齐有权使用的 SDK、模型和匹配预设后需重新运行构建，才能启用真实 Live2D。原适配器还从 `desktop/assets/jellyfish/presets.json` 读取匹配预设目录，该目录同样需要自行准备，不能直接套用任意模型。

## 2. 离线预览

从仓库根目录打开 PowerShell：

```powershell
cd windows/code/desktop-pet
npm.cmd ci
npm.cmd run dev
```

也可双击 `windows/Start-Windows.cmd`。首次运行安装依赖，之后构建后端和界面。资源齐备时可预览角色、拖动缩放及模型切换；文字显示 `Offline preview received: …`，不调用真实对话模型。预览不读取供应商凭据、个人聊天或微信登录状态。

点击角色聊天，使用大小手柄及全身 / 半身按钮调整显示。`Ctrl+R` 刷新，`Ctrl+Shift+I` 打开开发工具，通过退出按钮或 `Alt+F4` 关闭。按住发言的快捷键只在窗口有焦点且焦点不在输入框时生效；实体语音设备仍需另验收。

## 3. 首次配置真实服务

在 `windows/code/desktop-pet` 中执行：

```powershell
npm.cmd run build:windows
npm.cmd run configure-local
```

首次配置网页支持服务 Key、已适配模型和自己的参考音频。先开通所选服务并确认费用，再保存配置和激活。详见 [配置说明](docs/SETUP.md)；如果需要手写配置，以 `config/providers.example.json` 为模板，将凭据放在项目外的受限文件中。示例资源和音色 ID 必须替换为自己已登记的真实配置。

激活后启动：

```powershell
npm.cmd start
```

配置和数据位于 `windows/.local/`，不会随 Git 分发。服务调用可能收费；程序不会因选择本地前台对话就关闭其他云端组件。控制台地址和认证票据按会话生成，不要公开分享完整链接。

已有安装升级前先退出桌宠，保留自己的 `.local/` 数据、外部凭据和授权素材，然后执行：

```powershell
npm.cmd run build:windows
npm.cmd run refresh:runtime
npm.cmd start
```

`refresh:runtime` 面向当前目录已有的匹配配置，会备份配置和激活文件并更新运行指纹。它不是创建账号、迁移任意安装或跳过资源检查的工具。指纹不匹配时不要删除数据库或密钥来绕过检查。

## 4. 本地语音与对话

语音依赖和权重准备见 [本地 ASR/TTS 模块](local-models/README.md)。在 `windows/local-models` 中，每次启动一种模型，结束上一项后再运行下一项：

```powershell
node tools/start-speech-phase.mjs sensevoice-small
# Ctrl+C 结束后，才运行下一项：
node tools/start-speech-phase.mjs gpt-sovits
```

可选 ASR 为 `sensevoice-small`、`paraformer-zh`、`whisper-small`；TTS 为 `gpt-sovits`、`kokoro-82m`、`qwen3-tts-0.6b`。它们已做真实应用适配器调用，但不是实体设备、个人微调音色或识别率验收。GPT/Qwen 测试使用官方权重和合成参考。

退出已配置的桌宠，在 `windows/code/desktop-pet` 保存选择：

```powershell
node tools/configure-local-speech.mjs --config ../../.local/model-evaluation/trial/user-trial/config.json --asr sensevoice-small
# 单独测试 TTS 时，替换上一项选择；需先按语音文档登记 pet-smoke：
node tools/configure-local-speech.mjs --config ../../.local/model-evaluation/trial/user-trial/config.json --tts gpt-sovits --voice pet-smoke
```

配置工具保留备份与激活状态，`--off` 清除本地覆盖。只选择 ASR 或 TTS 时，另一项仍用原配置，可能调用云服务。本次资源保护与测试按模型串行运行，不宣称语音和本地 LLM 能同时加载。

Ollama 4B 准备、启动和前台选择见 [本地 LLM](docs/LOCAL-LLM.md)。该功能默认关闭；4B 存在已记录的计算和复述错误，完整后端有独立的云端记忆拒绝问题。9B 只完成下载和准备，用户已取消推理测试。

## 5. T3 / Codex / DeepSeek Harness

目标引擎为 Codex 0.160.0、DeepSeek Harness 0.2.0-rc.2，固定工具链 Node 24.13.1。新安装需按 [Windows 引擎说明](code/workbench/integration/engine-pins/README.md) 准备运行资源、构建和自己的账号；运行包、认证输入及已激活的个人 profile 不随仓库提供。

仅在固定运行资源与隔离 profile 已准备好后，从仓库根目录执行：

```powershell
$engineDirectory = node --input-type=module -e "import {engineDirectory} from './windows/code/workbench/integration/engine-pins/runtime.mjs'; process.stdout.write(engineDirectory);"
if ($LASTEXITCODE -ne 0) { throw '无法读取引擎目录' }
$reviewNode = Join-Path (Join-Path './windows' $engineDirectory) 'node/node.exe'
$reviewScript = './windows/code/workbench/integration/engine-pins/windows-review.mjs'
& $reviewNode $reviewScript open
& $reviewNode $reviewScript status
# 此命令会停止该 profile 的任务；确认不再需要继续后再执行：
& $reviewNode $reviewScript stop --confirm-stop-tasks
```

本次两种引擎均通过 T3 完成两轮同会话真实文件任务，Codex 另完成官方 app-server 同会话恢复。这与 Windows 原生 Codex App 同时双向写入、界面自动刷新和桌宠 UI 全路径是不同验收项。超时不自动重发任务。关闭工作台浏览器不等于停止后台。

## 6. 检查与限制

在 `windows/code/desktop-pet` 中按需要运行：

```powershell
npm.cmd run test:windows
npm.cmd test
npm.cmd run test:release
npm.cmd run test:stress
npm.cmd run test:windows:ui
npm.cmd run doctor
```

UI 检查需要实际授权资源与 SDK；普通回归多使用合成数据。`doctor` 不能代替真实账号、模型和设备验收。过去版本的记录见 [历史验证](WINDOWS-VALIDATION.md)，本候选版范围见 [2026-10-10 验证](docs/WINDOWS-20261010.md)。

| 现象 | 处理方式 |
| --- | --- |
| PowerShell 拒绝 npm.ps1 | 使用 `npm.cmd`，无需修改全局执行策略。 |
| 出现 WSL 路径或原生模块不是 Windows 文件 | 核对 Windows Node 和 `npm.cmd config get script-shell`；本目录使用 `cmd.exe`，修正环境后重新 `npm.cmd ci`。 |
| 凭据权限检查失败 | 按配置说明收紧所选文件权限，不跳过 ACL 与文件身份检查。 |
| 启动报告运行指纹变化 | 退出、构建，再对匹配配置执行 `refresh:runtime`。 |
| 本地模型被资源保护拒绝 | 结束不再需要的模型阶段，检查空闲 RAM / VRAM；不要绕过保护或自动停止其他应用。 |
| 后台记忆拒绝但前台有回复 | 查看 [已知问题](docs/LOCAL-LLM.md#完整后端与已知问题)；不要把前台成功当作记忆写入成功。 |

唤醒模型、实体麦克风 / 摄像头、扬声器效果、微信登录投递和长期连续运行需要单独验收。默认不启用持续监听。第三方素材与模型须遵守各自条款，见 [第三方来源与许可](THIRD_PARTY_NOTICES.md)。

## English

Use the separate Windows source tree and the PowerShell commands above. Supply licensed assets first; the offline preview only echoes input. Build, run first-run configuration, activate your own services, then start the backend. Quit before upgrading and refresh only the matching existing runtime configuration.

This development candidate has measured successes and known failures, not a complete acceptance pass. Three ASR and three TTS models ran through adapters with synthetic references; physical devices and personal fine-tuned voices remain unverified. Local 4B dialogue has arithmetic and recall failures, and a separate cloud background-memory conflict remains unresolved. 9B was downloaded/prepared but never loaded or tested, and the user cancelled that trial. See the [English overview](README.en.md), [measurements](docs/WINDOWS-20261010.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
