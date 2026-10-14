# Windows 本地对话接入

`localDialogue` 只替换桌宠前台回复。严格记忆、摘要、语义准入、视觉感知、工作规划和语音继续使用各自的配置，其中仍可能有云服务。正常桌宠后端因此不能称为全离线。没有 `localDialogue` 时继续使用原来的云端对话。

在 `AAAAGENT/windows/code/desktop-pet` 目录执行，先退出桌宠：

```powershell
node tools/configure-local-dialogue.mjs --config C:\path\to\config.json --model aaaagent-qwen35-4b:review
```

此命令只修改指定的配置与相邻 `activation.json`，会备份原始文件、保持激活状态、校验配置配对，并拒绝运行中的后端或并发语音配置编辑。它不会安装模型、启动服务、发送请求或改变其他模型配置。启用配置后，先启动所选本地服务，再重启桌宠。

默认参数如下；模型 ID 必填，服务必须已经安装对应模型。`contextWindowTokens` 必须与服务端设置一致，例如 Ollama 模型的 `num_ctx`。OpenAI 兼容请求本身不会替你修改服务端窗口。

```json
{
  "localDialogue": {
    "baseUrl": "http://127.0.0.1:11435/v1",
    "model": "aaaagent-qwen35-4b:review",
    "contextWindowTokens": 16384,
    "inputTokenLimit": 12000,
    "outputTokenLimit": 768,
    "timeoutMs": 120000,
    "reasoningEffort": "none"
  }
}
```

输入预算沿用整个请求的 UTF-8 字节保守上界，不是模型 tokenizer 的实际 token 数。默认角色、空历史、空视觉预设的首轮测试约为 9,666；长角色设定、视觉预设和历史会增加用量。必要内容超过预算时会明确失败，不截断后假装模型读到了全文。

请求使用 `/chat/completions`、非流式 JSON mode、`max_tokens` 和程序原有的回复/表情校验。`--reasoning none` 对 Ollama 发送 `reasoning_effort: "none"`；不支持这个扩展的兼容服务可用 `--reasoning server` 省略该字段。其他选项见 `--help`。

只允许带明确端口的 `127.0.0.1` 或 `[::1]` HTTP 地址。请求不带云端凭据、不走付费对话记账、不跟随重定向、不自动重试，也不在失败时切回云服务。调用取消、超时、超过 1 MiB 的响应、截断回复和无效结构都会结束本轮。

移除本地覆盖并恢复已有云端对话选择：

```powershell
node tools/configure-local-dialogue.mjs --config C:\path\to\config.json --off
```

完全不触发后台云组件的模型试验，应直接实例化 `dist/providers/local-dialogue.js` 的 `LocalDialogueProvider`。完整桌宠后端会运行其已配置的后台组件。
