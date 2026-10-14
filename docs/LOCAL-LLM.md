# Windows 0.3.0-dev.1 本地对话候选

本次使用 **Ollama + Qwen3.5 Q4_K_M**，经 OpenAI 兼容 `/v1/chat/completions` 接入桌宠前台。本文整理 2026-10-10 的实测结果与公开源码用法；这是开发候选，测试未全部通过。ASR、TTS 和本地对话模型分阶段运行。

默认启动器使用 `qwen3.5:4b-q4_K_M`，但默认应用配置仍使用已有云端对话，启用本地前台需明确选择。**9B 试验已按用户要求取消**：只完成下载与准备，资源检查未放行加载，没有推理结果。权重、私有配置和原始审核报告不随仓库分发，见 [第三方来源与许可](../THIRD_PARTY_NOTICES.md)。

## 框架选择

以下是截至 2026-10-10 查阅官方资料后的取舍，不是热度排名。

| 方案 | Windows 与接口 | 本项目的取舍 |
| --- | --- | --- |
| [Ollama](https://docs.ollama.com/windows) | 原生 Windows、NVIDIA；[OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility) | 实测版本 0.40.2；使用模型别名和上下文参数统一管理此次推理 |
| [LM Studio / llmster](https://lmstudio.ai/blog/0.4.0) | 桌面界面及独立服务进程；[OpenAI 兼容 API](https://lmstudio.ai/docs/developer) | 适合手动比较 GGUF 模型，可复用本次 HTTP 适配器；尚未实测此运行时 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | Windows CUDA 发行包，OpenAI 兼容 server | 更适合以后做可控的便携分发，但模型、模板和服务参数需要自行管理；尚未实测 |
| [vLLM](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/index.html) / [SGLang](https://docs.sglang.io/docs/get-started/install) | 官方 GPU 安装主要面向 Linux；vLLM 未正式支持原生 Windows | 此机器先不增加 WSL、容器和并发服务的资源负担 |

Ollama 的模型包 [`qwen3.5:4b-q4_K_M`](https://ollama.com/library/qwen3.5:4b-q4_K_M) 约 3.3 GB，含文本权重与视觉投影文件；本次只发送文字。另下载了约 6.6 GB 的 [`qwen3.5:9b-q4_K_M`](https://ollama.com/library/qwen3.5:9b-q4_K_M)，但没有加载或推理。下载大小不是显存占用，模型包和软件应分别遵守其上游条款。

## 启动与停止

以下命令从仓库根目录开始。需要原生 Windows、Node 22.12+、NVIDIA 驱动与 `nvidia-smi`，以及默认用户安装目录中的 Ollama；本轮实测版本为 0.40.2。启动器不包含 Ollama 安装器。首次下载和准备：

```powershell
cd windows/local-models
node tools/start-llm-phase.mjs --pull --prepare-only
```

开始独立的模型与桌宠适配器测试，完成后自动结束本次服务：

```powershell
node tools/start-llm-phase.mjs --verify
```

使用本地前台时，先保持下面的服务运行，再启动已配置的桌宠：

```powershell
node tools/start-llm-phase.mjs
```

默认是 4B，服务使用 `http://127.0.0.1:11435/v1` 和模型别名 `aaaagent-qwen35-4b:review`。权重下载到被 Git 忽略的 `windows/.local/local-models/ollama-models/`，不改写已有 Ollama 默认模型目录。输入 `stop` 后回车，或 Ctrl+C，结束启动器创建的服务与子进程。模型空闲 60 秒后可释放，下一次请求需重新加载。

启动器与语音启动器共享 19379 端口锁，拒绝同时运行；已有语音服务或默认 Ollama 已加载模型时也会拒绝。4B 启动要求至少 8 GiB 空闲内存、8 GiB 空闲显存，9B 要求 10 GiB / 11 GiB。运行中每两秒采样，低于 4 GiB 空闲内存或 2 GiB 空闲显存时停止自己创建的进程。语音启动器还检查 11434 / 11435 上是否有残留的已加载 Ollama 模型。此保护不管理其他软件，也不能保证采样间没有瞬时峰值。

服务配置为单模型、单并发、最大队列 2、16,384 上下文、最大 768 输出 tokens、4 个推理线程，并设置 `OLLAMA_NO_CLOUD=1`。[Ollama 的 OpenAI 接口不能直接设置上下文窗口](https://docs.ollama.com/api/openai-compatibility)，所以启动器创建带 `num_ctx` 的模型别名；应用预算必须与它一致。

## 应用接入边界

**只有前台回复改用本地模型。** 严格记忆、摘要、准入、感知与工作台仍使用各自的原配置，其中可能调用云服务并产生费用。关闭 Ollama 云功能不等于整个桌宠离线。

先按 [Windows 安装指南](../README-WINDOWS.md) 完成服务配置与激活。退出桌宠后，用 [本地对话配置工具](../code/desktop-pet/tools/local-dialogue.md) 修改当前安装的配置；以下命令从仓库根目录开始，标准配置路径如下：

```powershell
cd windows/code/desktop-pet
node tools/configure-local-dialogue.mjs --config ../../.local/model-evaluation/trial/user-trial/config.json --model aaaagent-qwen35-4b:review
# 恢复该配置原有的云端前台选择：
node tools/configure-local-dialogue.mjs --config ../../.local/model-evaluation/trial/user-trial/config.json --off
```

本地请求不读取云凭据、不进入付费前台对话账本、不跟随重定向、不自动重试或切回云端。保留原角色提示词、上下文预算、回复结构、表情校验和取消机制。兼容服务只允许明确端口的回环 HTTP 地址。默认 12,000 输入预算按 UTF-8 字节保守估算，并非 tokenizer 的实际计数；完整默认角色、空历史、空视觉预设首轮约 9,666。

## 验证记录

验证脚本在本地 `.local/local-models/reports/` 下生成 `api-benchmark.json`（输入、输出、延迟与 token 用量）和 `last-phase.json`（资源采样与服务版本）。后者随启动覆盖，需要自行保留测量记录。这些本地文件不是仓库中的可下载报告；本页公开汇总结果，不公开私人运行目录、账号或对话数据库。

测试依次覆盖冷请求、暖上下文回忆、JSON schema 计算、工具调用参数、Ollama 原生计时，以及两轮真实桌宠 `LocalDialogueProvider`。工具调用只检查参数，不执行天气查询。短合成样例用于确认链路和行为，不能替代长期角色一致性、事实正确率或编程能力评测。

### 4B 已观察到的结果与失败

在 Windows 11 x64 / Ryzen 7 9700X / 31 GiB RAM / RTX 5070 Ti 16 GiB 上，4B 使用 16K 上下文完全驻留 GPU，Ollama 报告分配约 3.38 GiB。两次测量的 GPU 总占用峰值 6,905 MiB，最低空闲内存 13,649 MiB，包含系统与其他应用。

首次安装后的首字为 44.506 秒、完成为 45.532 秒，包含首次初始化；停止服务后再次冷加载，首字 2.460 秒、完成 2.644 秒。暖短句首字为 65–72 ms；原生接口记录约 169–170 tokens/s。实际桌宠适配器的四次调用为 0.736–1.159 秒，含完整默认角色、结构化回复与表情，但未包含后台记忆和桌面显示。

**这组测试没有全部通过。** 两次均把 `(17 * 23) + 5` 答为 404（正确是 396），虽然 JSON 结构正确；第二轮桌宠复述在两次运行中一次正确，一次反问“今天过得怎么样？”。天气工具的单次调用参数通过，未执行工具。当前设置关闭思考、温度 0.3，4B 仅作为轻量候选，不能据此认为计算与上下文理解可靠。失败输出与测试退出码均保留。

### 完整后端与已知问题

隔离正式后端的 4B 前台调用已接通：完整请求保守预算 10,714 / 12,000，Ollama 实际输入 1,766 tokens，HTTP 返回约 3.814 秒，可见回复约 6.386 秒。请求不带 Authorization；独立账本没有云端 `dialogue` 操作。后台的准入与严格记忆仍调用云服务，本轮本地账本按登记费率记录 0.149802 元，未核对供应商账单。

该轮完整链路没有通过：前台准入将“不需要长期记忆”判为 `none`，后台严格记忆最终判为 `forget`；同轮助手已经落库，其来源扩展被 `source_expansion_contains_future_message` 拒绝。没有放宽保护，也没有发送计划中的第二轮。原始严格模型响应只保存摘要哈希；只读数据库与合成计划能复现同样拒绝，但不能冒充原始模型输出的逐字段回放。

只读检查确认实际没有第二轮用户消息：来源顺序 1 是当前用户，顺序 2 是同轮助手，助手依赖该用户来源。诊断用合成 forget 计划在只读数据库上得到相同拒绝；它不等于严格模型原响应的逐字段回放。实际提示词只包含 8 个允许预设，10,714 的保守输入预算未超限；162 个视频动作目录项目不整体进入提示词。

此问题与本地前台接口不同，换成 9B 不会自行修复。后续需分别澄清“不存长期记忆”与“删除既有内容”的语义，并处理后台计划与同轮助手落库的并发边界；不能直接取消未来来源保护或自动删除助手后代。本次未实施这部分修复，失败继续作为已知问题保留。

### 9B 仅下载准备，用户已取消测试

权重下载、校验和别名创建已经完成。2026-10-10 21:07 尝试实测时，空闲内存为 6,723 MiB、空闲显存为 8,094 MiB，低于 9B 启动要求的 10,240 / 11,264 MiB。启动器在创建服务和加载模型前退出；没有停止用户的其他程序。

因此没有 9B 延迟、质量或显存实测值。用户随后取消 9B 试验，本候选不把下载和配置准备算作推理验证，也不把它列为已通过的替代方案。已有应用的云端对话默认保持不变。

本次构建、14 项本地对话专项、81 项相关既有回归和 28 项 Windows 回归通过。分组包含重叠测试，不能相加成独立总数。单模型互斥已实际拒绝竞争启动；真实模型质量和后台记忆的失败不计为通过。
