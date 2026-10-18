# Windows：把这份文档交给本地 Agent 安装

[项目首页](../README.md) · [手动安装](README-WINDOWS.md) · [更换模型服务商](docs/PROVIDER_MIGRATION.md) · [架构与源码入口](../docs/ARCHITECTURE.md)

适用于 Windows x64 源码开发版。你只需把下面的请求交给能读写本机文件、执行 PowerShell 的编程助手。Agent 负责拉取完整源码、检查环境、安装依赖、构建、打开配置页并验证启动；你负责提供自己的服务账户、凭据和有权使用的角色资源。

**目前没有包含账号与角色素材的完整安装包。** 没有 Key 也能打开设置页；缺少角色资源时可以完成构建和离线预览，但正式启动仍有资源检查。首次安装耗时受下载与构建影响，不承诺一分钟完成。

## 直接复制给 Agent

先填写方括号中的选项。Key 填在本机设置页，不要贴进这段请求。

```text
请在我的 Windows 电脑安装并启动 AAAAGENT。
仓库：https://github.com/phoiex/AAAAGENT
先克隆完整源码，阅读 windows/AGENT_INSTALL.md 和 docs/ARCHITECTURE.md，
再按实际源码检查入口并执行安装，不要只总结 README 或让我逐条运行命令。

安装目录：[留空则用当前用户目录下的 AAAAGENT；已有安装请填原目录]
需要的功能：[默认：云端桌宠聊天与私人记忆；可加语音、工作台、QQ 社交记忆]
模型平台：[默认使用已适配服务；也可填自己的平台和官方 API 文档链接]
需要替换的能力：[无需替换 / 对话 / 后台记忆 / ASR / TTS / 图像 / 社交摘要]
角色资源目录：[我的 Live2D、SDK 或视频素材所在目录；没有就写“暂缺”]
音色：[默认系统音色；只有我明确要求才复刻音色]
工作台：[暂不安装 / Codex / DeepSeek Harness / 两者]
QQ：[暂不接入 / 我已有完整 QQ 机器人，路径是……]
云端验证：[配置完成后允许一轮短文字试聊 / 只安装，暂不调用模型]
登录后自动启动：[暂不开启 / 需要，先列出具体启动的组件]

使用 Windows 原生 Node/npm，默认走云端，不安装本地推理模型。
缺 Key 时打开本机设置页让我填写；缺登录或授权资源时一次列清缺项，
继续完成不依赖这些输入的工作。更换平台按 windows/docs/PROVIDER_MIGRATION.md
逐项修改和测试，不要把别家的 Key 填到百炼入口就宣布支持了。
保留已有聊天、记忆、凭据、素材和源码修改。不要覆盖现有安装或绕过启动校验。
最后报告安装路径、源码版本、已验证功能、待补配置、启动/停止方式和日志位置。
```

这份请求里的“本地 Agent”指在你电脑上操作的助手；桌宠调用的模型可以在云端。只会聊天、无法执行本机命令的网页助手不能代替安装过程。

## 先准备什么、填在哪里

| 项目 | 需要填写或提供的内容 | 填写位置 / 用途 |
| --- | --- | --- |
| 安装目录 | 自己可写的绝对路径；优先较短路径 | 上方请求；默认 `%USERPROFILE%\AAAAGENT`。避免把依赖放在网盘同步目录中。 |
| 默认文字模型 | 自己的 DeepSeek API Key、可用模型权限 | 首次设置页 → API Key；保存后，在对话、严格记忆、摘要、语义准入各模块选择凭据。 |
| 默认语音与图像 | 阿里云百炼 Key、对应地域和模型权限 | 首次设置页 → 阿里云百炼；绑定 ASR、感知和 TTS。当前内置适配使用北京接口。 |
| 其他服务商 | 官方 API 文档、完整 endpoint、模型 ID、认证方式、希望替换的能力 | 先交给 Agent 按[服务商迁移说明](docs/PROVIDER_MIGRATION.md)接入；凭据仍只保存在本机受限文件中。 |
| 声音 | 设置页列出的系统音色，或自己有权使用的参考录音 | 默认选系统音色。复刻需额外的模型权限、上传与费用确认；已有第三方 voice ID 不能直接冒充本项目登记记录。 |
| Live2D | `.model3.json`、其引用文件、匹配参数/预设及 Cubism Web SDK | 由 Agent 按[角色接入](docs/LIVE2D.md)适配；详见下方资源步骤。 |
| 视频角色 | 有权使用的视频、动作映射与相应素材目录 | 视频素材不随源码提供；不能只放一个 MP4 就视为完整适配。 |
| 工作台，可选 | Codex / Harness 自己的登录或凭据 | 在本项目隔离的引擎账户中配置，见[固定引擎说明](code/workbench/integration/engine-pins/README.md)。 |
| QQ，可选 | 完整机器人程序、自己的应用凭据、已绑定的群 | 在 QQ 机器人自己的配置中填写。本仓库只有桥接代码，不包含完整机器人发行包。 |
| 测试与费用 | 是否允许云端试聊、是否需要语音 | 在上方请求中说明。首次设置默认账本不设累计上限；一轮对话可能同时产生后台记忆、摘要等请求。 |

现有首次配置要求所有已登记模型模块选好对应凭据；“先只用文字”并不等于当前界面允许跳过所有语音/感知配置。想彻底移除百炼依赖，需把这些模块一起迁移，或者另行实现并验证禁用能力的配置流程。不要填写假 Key 来通过检查。

## Agent 执行流程

### 1. 检查电脑和完整项目

1. 确认是 Windows x64。ARM64、WSL 和 Mac 不走这份安装流程；Mac 使用根目录的[安装文档](../docs/SETUP.md)。
2. 检查 `git --version`、`node --version`、`npm.cmd --version`，以及 `node -p "process.platform + ' ' + process.arch + ' ABI=' + process.versions.modules"`。当前桌宠要求 Node 22.12+；本次安装验证使用 Windows Node 22.14.0。已有兼容 Node 可复用，固定工作台工具链另外处理。
3. 缺 Git 时从 [Git for Windows 官方入口](https://git-scm.com/install/windows)安装；缺 Node 时从 [Node.js 官方下载页](https://nodejs.org/en/download)选择 Windows x64、带 npm 的兼容版本。可使用官方入口提供的安装方式；不要把其他电脑的 `node_modules` 拷过来。
4. 已有目录先检查 `git status`、远程地址和 `.local/`，再决定继续安装或升级。不要自动重置用户修改、删除数据库或覆盖另一个项目。
5. 阅读[整体架构](../docs/ARCHITECTURE.md)、[Windows 手册](README-WINDOWS.md)、[首次配置](docs/SETUP.md)，并核对下列源码。只看仓库简介不足以判断安装完成。

| 需要核对的内容 | Windows 源码入口 |
| --- | --- |
| 构建脚本与实际版本 | `code/desktop-pet/package.json`、`package-lock.json`、`.npmrc` |
| 首次配置与资源缺项 | `app/self-setup.ts`、`tools/configure-local.mjs` |
| 激活与正式启动 | `app/trial-config.ts`、`app/trial-launcher.ts`、`desktop/electron/main.mjs` |
| 模型、凭据与声音 | `providers/`、`management/`、`config/providers.example.json` |
| 私人记忆 | `memory/`、`app/companion-data.ts` |
| 社交与 QQ | `companion/cloud/`、`tools/pet-cloud/`、`tools/pet-cloud/qq-bridge/` |
| 工程工作台 | `code/workbench/integration/engine-pins/`、`t3-source/` |
| 可选本地模型 | `local-models/`；默认安装不执行其中的模型下载/推理 |

表中 `app/`、`providers/` 等相对路径位于 `windows/code/desktop-pet/`。Windows 源码与仓库根目录的 Mac 源码分别安装和构建。

### 2. 拉取并一键准备

以下是全新安装的命令。Agent 可按用户指定目录替换 `$Repo`，每一步失败都应先处理错误再继续。

```powershell
$Repo = Join-Path $env:USERPROFILE 'AAAAGENT'
if (Test-Path -LiteralPath $Repo) { throw '目录已存在，请先检查是否为原安装。' }
git -c core.longpaths=true clone --depth 1 https://github.com/phoiex/AAAAGENT.git $Repo
if ($LASTEXITCODE -ne 0) { throw '源码拉取失败' }
git -C $Repo config core.longpaths true
if ($LASTEXITCODE -ne 0) { throw '仓库路径配置失败' }
Set-Location -LiteralPath $Repo
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Install-Windows.ps1
```

脚本会安装锁定的 npm 依赖、执行 `build:windows`、运行文件检查，然后启动首次设置服务并显示本机链接。最后一步会持续运行：保持终端会话，打开它显示的链接。该链接含会话令牌，只在用户本机展示，不写进公共日志或提交记录。

这条命令中的执行策略只作用于本次 PowerShell 进程，无需修改全局策略。脚本不下载个人角色、不填写 Key、不购买服务、不自动激活或调用模型，也不创建开机任务。网络下载可能需要代理；沿用用户指定代理，不关闭 TLS 验证。

Agent 需要分步执行时可用：

```powershell
# 只检查环境，不写配置、不安装依赖
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Install-Windows.ps1 -CheckOnly
# 只安装和构建，之后再单独打开设置页
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Install-Windows.ps1 -PrepareOnly
Set-Location .\windows\code\desktop-pet
npm.cmd run configure-local
```

已有正式配置时安装脚本会停止并保留它，改走下方“升级”。已存在设置/后端锁时先确认所属进程；不能用删除锁文件来强行启动第二个实例。

### 3. 准备角色资源

公开源码不含购买的角色、私人视频、Cubism SDK、音色和模型权重。缺资源时构建会提示 Live2D 未安装，这与依赖安装失败是两种不同状态。

- Live2D 渲染资源按[角色接入文档](docs/LIVE2D.md)放入 `code/desktop-pet/desktop/assets/local-model/`，SDK 放入 `desktop/vendor/cubism/`。SDK 从 [Live2D 官方入口](https://www.live2d.com/en/sdk/download/web/)取得。
- 当前后端的 `management/presentation.ts` 和部分渲染代码还读取 `desktop/assets/jellyfish/` 中的真实模型及匹配预设；`configure-model.mjs` 默认生成到 `local-model/`。Agent 必须核对两处读写路径和资源指纹，使它们指向用户的同一套授权资源。不能只改文件夹名、写空模型或禁用校验。不同角色的参数映射需要适配。
- 视频模式可以在未安装 Cubism 时构建预览，但当前正式配置仍检查表现目录。只有视频素材而缺少该目录时，明确报告缺项，不能把离线预览宣布为完整正式启动。
- 补资源或改适配后，先结束设置服务，再重新 `npm.cmd run build:windows`，然后重新打开设置页。使用自己账号或素材时保留原授权与署名。

如果用户暂时没有资源，完成依赖、构建及设置页，列出缺少的文件与取得方式；不要向用户索取或复制作者的私人运行目录。

### 4. 填 Key、选模型、保存并激活

1. 在本机首次设置页保存 Key。界面保存时会自动做一次连接测试；它只检查对应供应商的模型目录，不代表所有模型权限均已开通。
2. 在每个模型模块选择对应凭据和已适配型号，再保存设置。首次默认支持 DeepSeek / 百炼；更换平台先完成[迁移说明](docs/PROVIDER_MIGRATION.md)中的适配。
3. 默认选择已列出的系统音色即可。上传参考音频与付费复刻是额外步骤，不能为了安装自动创建音色。声音资料和旧登记记录应保留。
4. 根据页面列出的缺项完成资源与构建。点击完成设置后状态为 `prepared`，尚未启用正式启动。
5. 用 `Ctrl+C` 正常关闭设置服务。然后在 `windows/code/desktop-pet/` 中运行：

```powershell
npm.cmd run configure-local -- --activate-existing
if ($LASTEXITCODE -ne 0) { throw '激活未通过，请检查配置、资源和权限。' }
npm.cmd start
```

激活重新验证文件指纹和外部凭据权限，本身不调用模型。`npm.cmd start` 才是正式入口；`npm.cmd run dev` 和旧的 `Start-Windows.cmd` 是离线预览，显示 `Offline preview received: …` 只能证明预览运行。

Agent 应保留长驻终端或启动一个有明确日志路径的后台进程。创建后台辅助进程时隐藏 PowerShell 窗口，并记录自己的 PID 和启动入口；不要关闭执行会话后误报应用会持续运行。

### 5. 验证到什么程度才算完成

| 检查 | 合格证据 |
| --- | --- |
| 下载与构建 | 记录 `git rev-parse HEAD`、Windows Node 版本；`npm ci`、`build:windows` 返回成功。 |
| 本机设置 | 页面和其脚本可访问；无 Key 时准确显示缺项；用户填入的 Key 不出现在报告中。 |
| 配置与激活 | `config.json` 属于当前绝对路径，`activation.json` 为 `active`，启动通过指纹及权限检查。 |
| 正式应用 | Electron 窗口和匹配的后端进程均存在；从桌宠打开“管理”页面成功。不能只检查一个端口。 |
| 云端聊天 | 用户允许后，进行一轮短文字试聊，确认供应商的真实回复及错误状态；本地模型调用为 0，离线回显不算。 |
| 记忆 | 查看本轮记录及后台处理状态，另行验证跨重启保留。前台有回复不能证明长期记忆成功。 |
| 语音 / 角色 | 只有实际检查过发言、播放、打断、口型、模型显示的项目才标为通过。 |
| 外部渠道 | 没有用户指定的接收对象和发送授权时，用隔离数据验证；不能为了安装往真实 QQ / 微信联系人发测试消息。 |

`npm.cmd run doctor` 只查本地文件，退出码成功不代表 Key、角色或真实对话全部可用。代码适配后运行 `npm.cmd run test:setup` 与有关适配器测试；这些用合成凭据/音频，不调用真实模型，不证明模型质量。当前开发版已知问题见 [Windows 验证](docs/WINDOWS-20261010.md)。

## 按需加装的功能

### T3 工作台、Codex 与 DeepSeek Harness

跟随[固定引擎完整步骤](code/workbench/integration/engine-pins/README.md)：下载校验固定引擎、构建 T3、打包、创建隔离 profile，再配置自己的账户。此模块有独立 Node 24.13.1 工具链，不能把 Node 22 下安装的 SQLite 原生模块拿给 Node 24 运行。若采用工作台的 Node 构建桌宠，也要保持之后启动使用同一 Node/ABI，并重新核对激活。

只要聊天时，不必先安装整个工作台。不得从其他用户机器复制引擎登录状态。工作台网页关闭后后台可能仍在工作，停止请使用它的 `windows-review.mjs stop --confirm-stop-tasks`，确认当前任务不再需要继续。

### QQ 与社交记忆

先确认用户确实拥有能运行的完整 QQ 机器人及自己的账号，再按[社交说明](docs/SOCIAL_MEMORY.md)和[QQ 桥接说明](code/desktop-pet/tools/pet-cloud/qq-bridge/README.md)接入。

`configure-windows.mjs` 是现有部署布局的连接工具，默认期望仓库旁有 `VerinaBot/VerinaQQBot-Windows`，并从该迁移包读取绑定群、凭据文件和 Node。新用户目录不符时，Agent 要先核对并适配这些路径；不能原样执行后声称已安装 QQ，也不能凭空生成一个机器人账号。

社交摘要独立于私人记忆，桌宠只同步允许共享的摘要。默认服务端口为 `18766`，现有 QQ 管理页为 `18765`；桌宠自己的设置/管理页使用动态地址，别把这三个入口混在一起。社交摘要可以换兼容云平台，见[迁移说明](docs/PROVIDER_MIGRATION.md#社交摘要的快速配置)。

### 本地模型与长期运行

只有用户明确选择本地模型时，才继续[本地语音](local-models/README.md)或[本地对话](docs/LOCAL-LLM.md)，逐项准备权重和资源，不作为默认安装前提。

需要长时运行时，桌宠依赖交互式登录桌面；当前社交服务的计划任务也在用户登录后启动，不等同于注销后仍运行的系统服务。先完成手动启动验证，再按用户选择设置自启动。多个安装副本不要抢用同名计划任务、同一数据库或同一端口。

## 下次启动、升级和恢复

下次只需在同一目录使用 `npm.cmd start`。用桌宠面板退出，避免按进程名批量结束所有 Node/Electron；它们可能还运行着其他工作。

升级前正常退出属于本安装的桌宠、设置服务和相关后台，备份 `windows/.local/`、外部凭据及自己的授权素材。检查工作树后，仅对没有用户改动的原安装执行 `git pull --ff-only`；有源码适配时先保留改动，再由 Agent 合并。

```powershell
# 从同一安装的 windows/code/desktop-pet 中执行，逐项确认成功后继续
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖更新失败' }
npm.cmd run build:windows
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
npm.cmd run refresh:runtime
if ($LASTEXITCODE -ne 0) { throw '当前安装的运行指纹更新失败' }
npm.cmd start
```

`refresh:runtime` 更新已有安装并保留激活状态，不创建新账号或迁移别人的配置。更换目录不能直接复制旧激活文件；恢复时使用同一版本、同一安装位置及对应备份，避免数据库或运行指纹错配。

| 资料 | 默认位置 |
| --- | --- |
| 配置、激活、模型选择、管理会话描述 | `windows/.local/model-evaluation/trial/user-trial/` |
| 私人记忆和声音登记 | `windows/.local/data/companion.sqlite`、`registered-voices.json` |
| 费用账本 | `windows/.local/model-evaluation/budget.json` |
| 设置页保存的 Key | 用户目录 `.aaaagent/credentials/<安装路径摘要>/`，位于项目外；不要整目录公开。 |
| 社交服务和桌宠缓存 | `windows/.local/social-service/`、`windows/.local/data/social-cache.sqlite` |
| 日志 | 前台启动时在启动终端；后台运行时由启动者保存并报告实际 stdout/stderr 文件。错误报告需去掉凭据、会话链接及私人聊天。 |

## 常见问题

| 现象 | Agent 应检查什么 |
| --- | --- |
| `npm.ps1` 被执行策略拒绝 | 使用 `npm.cmd`。 |
| SQLite ABI 不匹配 / 缺 Electron | 核对 Windows Node 版本和架构，停止本安装后用同一 Node 重新 `npm.cmd ci`；不要混用其他平台依赖。确需源码编译时按报错安装 C++ Build Tools / Python。 |
| npm / Electron 下载失败 | 核对网络、用户代理、磁盘和具体失败 URL；保持 TLS 校验，不盲目替换全部注册源。 |
| 没有角色 / 模型加载失败 | 查实际素材路径、SDK、预设、参数映射及指纹，再重新构建。图片设计稿不是运行模型。 |
| 新安装仍提示需要 Mac 应用 | 确认使用本文对应更新后的 `windows/` 代码，不能运行根目录的 Mac 入口。 |
| 页面显示已有配置或锁被占用 | 继续使用原安装；先核实相关进程，保留配置。不要删数据强行重装。 |
| 连接测试通过，但对话或语音报错 | 分别检查选中模型的权限、地域、额度、参数及返回格式；模型目录鉴权不等于推理权限。 |
| 改 URL 后被拒绝 | 这是当前适配器与供应商登记检查；按[迁移说明](docs/PROVIDER_MIGRATION.md)添加对应适配，不能删除校验了事。 |
| 聊天只能回显 | 启动了离线预览；完成配置和激活后用 `npm.cmd start`。 |
| GitHub 下载后找不到 QQ 程序 | 公开仓库只有社交桥接，需另有完整机器人；报告缺项。 |

## Agent 交付格式

```text
安装目录：
源码提交 / Node 版本：
已完成：依赖 / 构建 / 设置 / 激活 / 桌宠 / 云端对话 / 记忆
未完成及原因：
各能力使用的服务商与模型（不含 Key）：
启动 / 停止 / 更新命令：
实际日志位置：
自启动状态：
用户还需填写或准备：
真实云调用次数、测试范围与未验证项：
```
