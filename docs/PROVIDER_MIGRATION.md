# 换一个模型平台：交给 Agent 的快速修改说明

[Agent 安装](../AGENT_INSTALL.md) · [模型与声音设置](SETUP.md) · [项目架构](../../docs/ARCHITECTURE.md)

**不必固定使用阿里云。** 项目按能力分开调用服务，可以让对话、记忆、语音和图像使用不同平台。不过，当前桌宠设置页只登记了 DeepSeek 与百炼，以及各自已经适配的型号；任意厂商的 URL 和 Key 还不能直接通用。新增平台需要核对接口并修改相应适配器，下面给出具体入口。

以下依据 Windows 当前源码，文档更新日期为 2026-10-18。示例的域名、模型名和路径都是待替换项，不表示该平台已接入或已测试。

## 先判断需要哪种修改

| 想换什么 | 操作 |
| --- | --- |
| 设置页已有的型号 / 同平台另一把 Key | 在“模型与声音”保存 Key、选择模块凭据与型号、保存并重启。通常无需改源码。 |
| 平台相同，但型号或地域不在当前列表 | 核对官方请求格式、能力与计价，扩展型号目录和允许的 endpoint，并增加对应测试。不能只换模型字符串。 |
| 新平台的文字对话，兼容 Chat Completions | 通常能复用对话上下文与响应解析，但仍需接入供应商登记、凭据、配置校验、参数差异和费用处理。 |
| 只有 Responses、Messages 或其他专有协议 | 写独立请求/响应适配器，转换为项目内部契约；不能把 URL 填进 Chat Completions 请求体后直接使用。 |
| ASR、TTS、图像理解 | 分别核对音频/图片输入、输出结构、采样率与认证方式。文字接口兼容不代表这些接口兼容。 |
| 已初始化社交服务的摘要模型 | 现有服务支持一类 OpenAI 兼容接口，满足下方条件时可以只改服务配置。 |
| 完全不使用阿里云 | 一起处理 ASR、perception、TTS 及其首次配置要求；只替换前台对话不会移除其他模块的百炼依赖。 |

目前的 `MiniMax/speech-…` 接入是**百炼托管 MiniMax**。MiniMax 官方直连的 Key、endpoint、voice ID 或克隆记录不能直接当作百炼凭据使用；直连须单独适配。

## 复制给 Agent 的请求

```text
请把 AAAAGENT Windows 的以下能力接到我的云端模型平台：
项目安装路径：[绝对路径]
平台名称：[平台]
官方 API 文档：[链接，包含请求和响应示例]
希望替换的能力：[dialogue / memory_turn / summary / admission / asr / tts / perception / 社交摘要]
完整接口地址：[含实际 API 路径，不只是网站域名]
准确模型 ID：[填写每项模型；不是网页显示名称]
认证方式：[Bearer Key / api-key 请求头 / 其他]
凭据位置：[由你打开本机页面让我填写，或我提供受限文件的路径；不要在聊天中索取明文 Key]
模型能力：[结构化 JSON、流式、上下文/输出上限、思考参数；语音再填格式和音色]
计费资料：[官方链接、币种、输入/输出或音频单价]
测试授权：[允许多少次云端调用 / 只做代码和合成测试]

先读 windows/docs/PROVIDER_MIGRATION.md，再查看实际配置、协议与工厂代码。
列出受影响模块，只修改指定能力，保留聊天、记忆、人设、已有 Key 和旧平台选项。
新增供应商登记和适配器，保留凭据隔离、费用预留、取消、超时、来源和遗忘校验。
不要用本地模型或另一平台静默回退。做接口模拟测试后，在授权次数内用云端验证。
最后重新构建、更新本安装运行指纹、重启，并报告各模块实际使用的平台及验证结果。
```

若只知道平台名称，让 Agent 先阅读该平台官方文档并提出适配方案。不要把“兼容 OpenAI”的宣传当作所有参数、JSON 输出、流式或语音都兼容的证据。

## 桌宠文字能力：最短修改路径

下面所有源码路径以 `windows/code/desktop-pet/` 为根。可以按能力小步接入，首先替换 `dialogue`，保留其他模块的原配置；验证通过后再迁移后台能力。

| 步骤 | 修改位置 | 要完成的内容 |
| --- | --- | --- |
| 1. 登记供应商 | `app/trial-config.ts`、`contracts/management.ts`、`contracts/self-setup.ts` | 扩展供应商类型和适用能力、准确的 HTTPS endpoint / 型号校验；不能删除原校验或把新平台伪装成 `dashscope`。 |
| 2. 保存和测试凭据 | `management/credential-store.ts`、`credentials.ts`、`self-setup-routes.ts`、`credential-smoke.ts`、`management/ui/self-setup-view.mjs` | 增加 Key 的供应商身份、受限存储、页面入口及认证测试。测试地址和返回格式按厂商实现；某平台没有模型目录接口时明确测试范围，不能发出收费生成请求却标为免费鉴权。 |
| 3. 给页面提供选项 | `providers/management-catalog.ts`、`management/settings.ts`、`app/self-setup.ts` | 新增 adapter、模型、能力与价格项；保持模块选择和 `credentialRef` 一致。默认提供者只在用户要求时改。 |
| 4. 接请求协议 | `providers/transport.ts`、`providers/text-protocol.ts`、`providers/dialogue-thinking.ts` | 检查请求头、JSON 参数、思考开关、流式及响应结构。当前传输默认是 Bearer + JSON；不同认证或协议需独立适配。 |
| 5. 接运行入口 | `app/dialogue-selection.ts`、`app/trial-backend.ts` | 使新选择真正实例化对应 provider；不要只添加页面下拉项。`TrialTransport` 也校验实际模型和 endpoint。 |
| 6. 保持输出契约 | `providers/qwen-dialogue.ts`、`dialogue-request.ts`、`memory-turn-provider.ts`、`qwen-memory-lifecycle.ts`、`app/memory-semantic-adapter.ts`、`memory-semantic-format.ts`、`trial-admission.ts` | 对话返回结构化内容与表现意图；正式严格记忆经语义格式和编译器处理，摘要和准入也有独立解析。不能把普通字符串答复当成合格的记忆计划。 |
| 7. 对齐预算 | `providers/input-count.ts`、`management-catalog.ts`、`app/trial-config.ts`、`app/trial-backend.ts` | 登记真实上下文、输出容量、计价单位、usage 与保守预留。当前账本以 CNY micros 记录，不可把美元价格原样写进去；未知费用保留未知。 |

可用 `rg -n 'deepseek|dashscope|strict-deepseek|enable_thinking|thinking' app contracts providers management` 查漏，逐处判断用途，不做整个仓库的全局文本替换。

请求格式可先与下面的最小例子比对；这是协议示意，不是可直接导入桌宠的配置：

```json
{
  "model": "YOUR_MODEL_ID",
  "messages": [
    {"role": "system", "content": "返回合法 JSON。"},
    {"role": "user", "content": "输出一个简短问候。"}
  ],
  "stream": false,
  "response_format": {"type": "json_object"}
}
```

适配器必须确认能取得 `choices[0].message.content` 或把厂商响应转换成项目要求的形式。不要给所有厂商统一加上 `enable_thinking`、`thinking`、`reasoning_effort`、`max_tokens` 或 `max_completion_tokens`；只发送官方支持且已经验证的字段。

`dialogue` 是前台答复，`memory_turn` 是严格记忆计划，`summary` 是摘要，`admission` 是语义准入。它们可以使用不同云端模型。当前 `memory_turn` 明确绑定 DeepSeek 并有严格来源、纠正和遗忘协议；迁移它要保留这些约束并单独验收。只成功收到一句“你好”不足以证明记忆迁移成功。

## 语音和图像各改哪里

| 能力 | 主要代码 | 需要核对 |
| --- | --- | --- |
| ASR 语音识别 | `providers/qwen-asr.ts`、`providers/split-perception.ts`、`contracts/` 中 ASR 契约、`app/trial-backend.ts` | 输入是 multipart 文件、base64 还是 URL；编码/采样率、长度限制；输出只做转写，不用聊天模型猜测没识别出的内容。 |
| 图像 / 视觉情绪 | `providers/qwen-visual-emotion.ts`、`qwen-perception.ts`、`app/trial-backend.ts` | 图片字段、尺寸、格式、输入额度和结构化输出；未知情绪仍保持未知，不捏造数值。 |
| TTS 语音合成 | `providers/qwen-tts.ts`、`qwen-audio-tts.ts`、`minimax-tts.ts`、`app/trial-backend.ts` 的 `createTrialTtsProvider` | 厂商 voice ID、风格参数、PCM/WAV/MP3、采样率与播放格式；打断后不继续播放旧声音。 |
| 音色登记 / 复刻 | `providers/registered-voices.ts`、`voice-enrollment.ts`、`management/voice-setup.ts` | 音色和厂商、endpoint、模型、凭据绑定；新厂商重新登记。保留费用确认和结果未知时的防重试规则。 |

上述能力也要同步修改供应商类型、设置页和校验。新平台没有某项能力时，可以保留原模块；若用户要求禁用，则需要实现明确的禁用状态及启动、路由、界面行为，不能靠缺 Key 或空字符串让调用失败。

联网搜索和天气属于检索链路。换模型 API 并不自动获得搜索能力；QQ 迁移包的搜索实现也不能与桌宠供应商配置混为一谈。

## 社交摘要的快速配置

**已初始化的社交服务**有一个较直接的接入点：`companion/cloud/model.ts` 中的 `OpenAICompatibleSocialModel`。它使用完整 endpoint、模型名和独立凭据。新服务要满足：

- HTTPS + Bearer 认证，支持 `messages`、`stream: false`、`max_tokens: 1000` 和 `response_format: {type: 'json_object'}`。
- 返回 `choices[0].message.content`，`finish_reason` 为 `stop`；内容为项目要求的 JSON。已送达 QQ 回复的摘要模式必须有 `summary`，通用发言模式还需要 `text`。
- 取消、超时、非法 JSON、截断以及 HTTP 错误要按当前服务处理，不能伪造摘要成功。

满足时，停止社交服务，备份 `windows/.local/social-service/service.json`，**仅替换其中的 `model` 部分**，其余角色、群策略、端口和服务 token 保留。例如：

```json
{
  "endpoint": "https://YOUR_PROVIDER_HOST/v1/chat/completions",
  "name": "YOUR_MODEL_ID",
  "credentialFile": "C:\\AAAAGENT-secrets\\social-api.key"
}
```

这是 `model` 子对象示例，不是整个 `service.json`。`credentialFile` 可指向受限的纯文本 Key 文件；若使用 JSON 凭据文件，再填写 `credentialField` 指定属性名。保持文件和目录的 Windows 私有 ACL。选择不同字段、HTTP 认证、输出结构或不支持 JSON 模式的服务时，仍需修改 `companion/cloud/model.ts`。

之后从 `windows/code/desktop-pet/` 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/pet-cloud/Manage-Social.ps1 -Action status
```

健康检查只证明服务可运行，摘要推理须另用隔离事件验证。检查启动环境中的 `PET_SOCIAL_MODEL_ENDPOINT`、`PET_SOCIAL_MODEL`、`PET_SOCIAL_API_KEY_FILE` 和 `PET_SOCIAL_API_KEY` 是否覆盖了文件配置，只核对是否设置，不输出 Key。更改摘要平台后，**不要无参数重跑 `configure-windows.mjs`**：它按原 QQ 迁移包写入 DeepSeek 默认值。QQ 自身的回答模型保存在迁移包里，桌宠模型保存在桌宠配置里；改社交摘要只影响摘要服务。

## 修改后怎样验收

在 `windows/code/desktop-pet/` 中先跑不收费的检查：

```powershell
npm.cmd run check
npm.cmd run test:setup
npm.cmd test
# 改了社交摘要时再运行
npm.cmd run test:social
```

新适配器还应有针对性的模拟接口测试，验证请求只发往指定端点、凭据不出现在错误/日志中、请求与响应格式正确、取消和超时有效、错误不会静默切换到其他平台。涉及记忆时验证来源、纠正、遗忘和持久化；涉及语音时验证真实音频格式和打断。

用户允许真实验证后，按明确的调用次数使用**云端模型**，先测一项能力，再测相关链路；不要为了冒烟测试克隆音色或给真实群发消息。验证记录写明模型、接口协议、调用次数和未通过项，不写入私人文本或凭据。

最后退出当前安装的应用，重新 `npm.cmd run build:windows`，已有配置执行 `npm.cmd run refresh:runtime` 后用 `npm.cmd start`。全新安装则按[安装文档](../AGENT_INSTALL.md)完成设置和激活。保留旧配置备份；回滚代码时也要恢复与该版本匹配的配置和依赖，避免新 adapter 留在旧版本配置中。

这份文档提供迁移路线，不表示未列出的平台已经受支持。交付报告应列出每个模块实际使用的厂商、已验证接口，以及还保留在哪个平台上的能力。
