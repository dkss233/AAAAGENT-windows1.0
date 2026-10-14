# Windows 第三方来源与许可

核验日期：2026-10-11。本文件说明 Windows 源码中引用、适配或可选加载的第三方项目，不是这些资源的统一授权。仓库根目录的 AAAAGENT 许可只覆盖作者有权许可的原创内容；第三方原有许可、版权和署名要求继续有效。发布源码与分发包含模型、SDK、媒体和依赖的可运行安装包，需要分别核对。

## 视频桌宠：PC2005-cloud / dsh-pet

视频桌宠素材来源为 **[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)**，导入版本 `0.3.6`，固定提交 `d422f274e7ca0580dc8e4370fd96ca4d2b4d84b3`。AAAAGENT 做了 Windows Electron 播放、动作状态、表情映射和 Live2D 切换适配；原始角色视频和图片不应标为 AAAAGENT 原创。

上游明确区分两类许可：

- **代码：MIT**，`Copyright (c) 2026 PC2005-cloud`。保留版权和许可全文，见本地 [桌宠 NOTICE](code/desktop-pet/desktop/NOTICE.md) 与[固定提交 LICENSE](https://github.com/PC2005-cloud/dsh-pet/blob/d422f274e7ca0580dc8e4370fd96ca4d2b4d84b3/LICENSE)。
- **动画、提示词、源视频：允许开源使用，禁止商用**。衍生、改版、换皮作品在任何介绍、展示、分发之处，须附原项目 GitHub 地址。该要求见[固定提交 README 的许可部分](https://github.com/PC2005-cloud/dsh-pet/blob/d422f274e7ca0580dc8e4370fd96ca4d2b4d84b3/README.md#许可)，不能用代码的 MIT 许可代替。

本次源码发布不附带本地 `code/desktop-pet/desktop/assets/local-model/dsh-pet/` 媒体包。该本地包曾用于运行验证，含 106 个 WebM 和 27 个 PNG；运行者可按上游条款从固定版本另行取得，或提供自己有权使用的资源。上游许可段未逐项列出这些 PNG、表情素材和其中可能涉及的第三方内容的独立权利范围，因此不把整包图片推定为 MIT 或可任意商用。预览 GIF、录屏和截图也不能因是演示材料而省略原项目署名或扩大素材授权。

介绍视频桌宠时，应直接保留以下来源说明及链接，不能仅在依赖清单深处提及：

> 本项目的视频桌宠素材基于 PC2005-cloud 的 dsh-pet：<https://github.com/PC2005-cloud/dsh-pet>。代码采用 MIT；动画、提示词和源视频遵循上游非商业条款。AAAAGENT 提供 Windows 播放与状态接线适配。

## Live2D 模型与 Cubism SDK

Windows 本地验证使用过用户自行购买的 Live2D 模型。现有导入资料不足以独立确认原作者身份和公开再分发授权，不能通过角色名称或搜索结果猜测作者。购买使用权不等于取得公开分发模型文件的权利。

以下目录作为完整私有资源目录排除，不仅排除 `.moc3`：

- `code/desktop-pet/desktop/assets/local-model/`；
- `code/desktop-pet/desktop/assets/jellyfish/`。

其中的纹理 PNG、物理配置、模型配置、动作、表情和其他配套文件均不随本次源码发布。相关演示图片和录像还须遵守模型原授权。本项目不会为该购买模型再授予许可；运行者应自行准备有权使用的模型，并保留其原始署名和使用条件。

本地 SDK 记录为 **Cubism SDK for Web 5-r.5**，来源为 [Live2D 官方下载](https://www.live2d.com/en/sdk/download/web/)，归档 SHA-256 为 `67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0`。本地来源记录的范围仅为开发和运行验证，没有完成 SDK 分发审核。

Cubism Framework 使用 [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)，Cubism Core 使用 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)；参见 [5-r.5 Framework LICENSE](https://github.com/Live2D/CubismWebFramework/blob/5-r.5/LICENSE.md)。这两者都不能笼统标为 MIT。`code/desktop-pet/desktop/vendor/` 不随本次源码发布；开发者应从官方取得 SDK，保留其 LICENSE/NOTICE，并按实际应用的发布方式核对 Live2D 条款。将 SDK 打包进生成的 JavaScript 或安装包不会消除这些要求。

## T3 Code、覆盖层与附属资源

工作台基于 **[T3 Code / pingdotgg/t3code](https://github.com/pingdotgg/t3code)**，固定提交 `c13f7d93fff0f578886985a3f673b4b21b7f6ac8`。上游代码为 **MIT**，`Copyright (c) 2026 T3 Tools Inc.`，见[固定提交 LICENSE](https://github.com/pingdotgg/t3code/blob/c13f7d93fff0f578886985a3f673b4b21b7f6ac8/LICENSE)。本地 [t3-source/LICENSE](t3-source/LICENSE) 和 [t3-native/LICENSE](code/desktop-pet/t3-native/LICENSE) 应随各自源码保留。

`t3-source/` 是已应用 AAAAGENT 补丁与覆盖层的构建源码快照，不是未修改的上游发行版；来源与修改范围见 [AAAAGENT-ASSEMBLY.md](t3-source/AAAAGENT-ASSEMBLY.md) 和 [t3-source.json](code/workbench/integration/t3-source.json)。修改说明不取代上游许可，也不把上游代码重新许可为 AAAAGENT 的原创内容。

T3 的根 MIT 许可不能概括目录内每一种媒体、字体、原生库和外部工具。保留 [third-party-licenses.config.json](t3-source/third-party-licenses.config.json) 及各组件的嵌套许可；制作二进制发行包时，还需保留构建生成的相应第三方声明。已识别的例子包括：

| 资源 | 来源及已有许可记录 |
| --- | --- |
| libghostty-vt | 固定 [Ghostty 提交 `9f62873bf195e4d8a762d768a1405a5f2f7b1697`](https://github.com/ghostty-org/ghostty/tree/9f62873bf195e4d8a762d768a1405a5f2f7b1697)，MIT；本地 [LICENSE](t3-source/native/libghostty-vt/LICENSE)，Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors。保留该许可、VERSION 和构建脚本后，可包含对应的 `ghostty-vt.wasm`；配套 `ghostty-write-pty.wasm` 是 T3 的回调桥接产物，适用 T3 的许可。 |
| Symbols Nerd Font Mono | 本地 [字体 LICENSE](t3-source/apps/web/src/terminal/ghostty/fonts/LICENSE) 和上游符号字体目录标为 MIT，Copyright (c) 2014 Ryan L McIntyre；但合并图标源另有条件及未明确授权项，本次不分发该 WOFF2，详见下文与[字体 NOTICE](t3-source/apps/web/src/terminal/ghostty/fonts/NOTICE.md)。 |
| 提示音来源 | [Notification Sound 1](https://freesound.org/people/deadrobotmusic/sounds/750607/) 和 [Notification Sound 3](https://freesound.org/people/deadrobotmusic/sounds/750609/) 作者 deadrobotmusic；[Folder_Whoosh.wav](https://freesound.org/people/BaggoNotes/sounds/704258/) 作者 BaggoNotes；[Contarex camera shutter.wav](https://freesound.org/people/Tonik1105/sounds/520684/) 作者 Tonik1105。T3 清单与四个原页面均标记 CC0-1.0；本次仅将对应的四个必要 MP3 加入发布白名单，精确文件映射见[音频 NOTICE](t3-source/apps/web/src/assets/NOTICE.md)。 |
| 可选设备工具 | `agent-device` 的记录为 MIT；`expo-device-hub` 的组合记录为 MIT、Apache-2.0、BSD-3-Clause，不能只保留一个 MIT 标签。详见上述 T3 许可清单。 |

T3 的 `assets/` 品牌图标及 `apps/web/public/` 对应图标是上游源码资源，其用途和生成来源见 [assets/README.md](t3-source/assets/README.md)。保留上游 MIT 与 T3 来源说明；不得将 T3 标识宣称为 AAAAGENT 原创品牌，或暗示本项目得到 T3 的官方认可。

### Nerd Font：合并图标不能仅按目录 MIT 概括

本地 `SymbolsNerdFontMono-Regular.woff2` 的字体元数据标记为 Nerd Fonts `3.4.0`，含 10,410 个字符映射，包括 `linux-apple` 等 Font Logos 字形。[该版本上游许可审计](https://github.com/ryanoasis/nerd-fonts/blob/v3.4.0/license-audit.md) 同时列出 CC BY 4.0、Apache-2.0、OFL 字形来源，并将 Font Logos 标为 Unlicensed。因此，本次保留目录 MIT 文件与来源 NOTICE，但不分发该合并 WOFF2；需要这些字形的用户应自行核对完整组件条款或使用授权明确的字体。此结论不否定 Nerd Fonts 自身的 MIT 授权，只是不将它扩展为所有合并图标的独立授权。

### Apple 设备模型：没有确认再分发许可

`t3-source/apps/web/src/components/device/models/sources.json` 将设备模型作者列为 **Apple Inc.**，并明确写明没有建立开源或再分发许可；[固定上游来源记录](https://github.com/pingdotgg/t3code/blob/c13f7d93fff0f578886985a3f673b4b21b7f6ac8/apps/web/src/components/device/models/sources.json) 也如此说明。因此以下 5 个 GLB **不应纳入本次公开仓库或发行包**：

`iphone-18-pro.glb`、`iphone-18-pro-max.glb`、`ipad-pro-13-m5.glb`、`ipad-pro-13-m5-magic-keyboard.glb`、`iphone-duo.glb`。

保留来源元数据和[资源旁 NOTICE](t3-source/apps/web/src/components/device/models/NOTICE.md) 仅用于说明缺失资源与权利边界，不构成模型授权。不能因为文件可从 Apple 网站取得，或它们位于 T3 的 MIT 仓库内，就推定可以再分发。需要这些设备预览时，应先取得明确许可或替换为自有、授权明确的模型。

## 引擎、消息适配与运行时依赖

Windows 集成脚本引用的外部引擎与运行时通过安装流程另行取得，`artifacts/`、`node_modules/`、下载缓存与生成目录不随本次源码发布。

| 项目 | 核实范围 |
| --- | --- |
| OpenAI Codex `0.160.0` | [官方固定版本 LICENSE](https://github.com/openai/codex/blob/rust-v0.160.0/LICENSE) 为 Apache-2.0。若以后分发二进制或修改后的上游代码，应一并满足原许可、NOTICE 与修改说明要求。 |
| DeepSeek Harness `@deepseek-ai/dsh` `0.2.0-rc.2` | 已安装包的 package.json 与 LICENSE 均标为 MIT，版权为 2026 DeepSeek；[官方仓库 LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) 可供核对。运行包及其依赖各自的许可需要保留。 |
| Node.js、Electron 及 npm/pnpm 依赖 | 按锁定版本安装并保留原有 LICENSE 与第三方声明。Node/Electron 的主项目许可不取代其捆绑依赖的许可；本文件不是完整安装包的依赖清单。 |

微信适配来源已单独记载于 [openclaw-weixin.md](code/desktop-pet/third-party/openclaw-weixin.md)：参考 [Tencent/openclaw-weixin 固定提交](https://github.com/Tencent/openclaw-weixin/tree/7c04adc3e95775efd661ab9fba0626d86d237713)，MIT，`Copyright (C) 2026 Tencent. All rights reserved.`。适配未将 OpenClaw 插件运行时整体打入本项目。现有许可文件应保留：

- [openclaw-weixin.LICENSE](code/desktop-pet/third-party/openclaw-weixin.LICENSE)
- [qrcode.LICENSE](code/desktop-pet/third-party/qrcode.LICENSE)
- [pngjs.LICENSE](code/desktop-pet/third-party/pngjs.LICENSE)
- [dijkstrajs.LICENSE](code/desktop-pet/third-party/dijkstrajs.LICENSE)
- [silk-wasm.LICENSE](code/desktop-pet/third-party/silk-wasm.LICENSE)

本地语音与对话模型的权重、音色样本、SDK 和运行环境也不随源码发布；其下载与使用条件应分别依原模型卡、作者及供应商许可核对，不能由调用代码的许可推导。

## 本次发布边界

| 内容 | 本次处理 |
| --- | --- |
| AAAAGENT Windows 原创源码、文档、测试 | 可随源码发布，适用本项目自身许可。 |
| 引用或修改的 MIT / Apache 等第三方源码、补丁、来源锁文件 | 按原许可保留版权、完整许可与必要修改说明后发布；不统一改写第三方许可。 |
| T3 四个 CC0 提示音、MIT Ghostty WASM 和 T3 图标 | 保留精确来源与所需许可，随必要构建资源发布；不包括其他音视频或私有桌宠素材。 |
| dsh-pet WebM、PNG、源视频、提示词及演示媒体包 | 本次不附带；从上游按对应条件另行取得，并在介绍、展示和分发处保留直接来源链接。 |
| 购买的 Live2D 模型、纹理与配套文件 | 不公开；用户自行准备有权使用的资源。 |
| Apple 来源的 5 个 GLB | 未确认再分发许可，不公开。 |
| Symbols Nerd Font Mono 合并 WOFF2 | 部分合并图标未明确授权，本次不公开该字体文件；保留来源、MIT 与排除说明。 |
| Cubism vendor、模型权重、运行时和安装包 | 本次不附带；后续分发需要单独审查各自条款与完整依赖声明。 |
| `.local/`、用户配置、凭据、聊天/记忆数据库、私有验证截图和录屏 | 不发布。 |

本次核验从导入资料、版本锁、资源旁声明与上游官方仓库追溯来源；没有取得新的第三方授权。后续增加素材或制作安装包时，应更新对应来源与许可记录，而不是仅复用本文件的结论。
