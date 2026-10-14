# Windows 本地语音 — local-models 0.2.0-dev.1（源码开发候选）

[Windows 安装说明](../README-WINDOWS.md) · [真实验证记录](../WINDOWS-VALIDATION.md#2026-10-01-local-speech)

**2026-10-10：桌宠 0.3.0-dev.1 已接入本模块。** 对话继续使用云端配置；本地 ASR/TTS 通过应用适配器调用。此次重测每次只加载一个模型，9 段 WAV、27 次交叉转写及资源采样全部完成。最新启动、应用配置和耗时见 [Windows 本次适配](../docs/WINDOWS-20261010.md)。下表保留 10 月 1 日的模型准备结果；本模块随 Windows 开发候选发布源码，权重与运行环境另行准备。

后续增加了独立的 [Ollama 本地对话阶段](../docs/LOCAL-LLM.md)。语音与对话启动器共用模型互斥锁；先结束当前阶段，再启动下一项。语音测试中的对话默认配置保持云端，本地前台由专用配置另行选择。

## 六种已运行的方案

| 类别 | 模型 / API model | 运行方式 | 本机实测 |
| --- | --- | --- | --- |
| ASR 首选 | SenseVoice Small int8 / `sensevoice-small` | Node + sherpa，CPU | 官方录音及 9 份 TTS 音频完成转写，暖请求 40–64 ms；官方样例有“开放→开饭”误识别。 |
| ASR 中文备选 | Paraformer int8 / `paraformer-zh` | Node + sherpa，CPU | 同样完成转写，暖请求 34–45 ms；一条 GPT 样音有“本地→本店”误识别。 |
| ASR 多语言备选 | Whisper-small int8 / `whisper-small` | Node + sherpa，CPU | 修复中文 BPE 字节丢失后完成全部转写，暖请求 573–899 ms；可能输出繁体及个别同音词。 |
| TTS 主方案 | **GPT-SoVITS** / `gpt-sovits` | 原生 Windows v2Pro API，CUDA 12.8 | 3 条中文生成 32 kHz WAV，暖请求 1056–1598 ms；初次参考处理约 35 秒。用户微调音色需另验收。 |
| TTS CPU 备选 | Kokoro 82M v1.1 int8 / `kokoro-82m` | Node + sherpa，CPU | 3 条中文生成 24 kHz WAV，2174–3300 ms；固定音色。 |
| TTS GPU 备选 | Qwen3-TTS 12Hz 0.6B Base / `qwen3-tts-0.6b` | 原生 Windows Python，CUDA + SDPA | 3 条中文生成 24 kHz WAV，6058–8209 ms；无需 WSL、vLLM 或 FlashAttention。 |

机器为 Windows 11 x64、Ryzen 7 9700X、31 GiB RAM、RTX 5070 Ti 16 GiB。这些是短样例观察值，不能作为真实录音识别率或长期负载基准。GPT/Qwen 使用现有 Kokoro 合成参考音频和官方预训练权重完成运行验证，未使用用户的微调音色。

Whisper 的漏字已定位：sherpa 1.13.8 在每个 BPE token 上清理 UTF-8，丢掉跨 token 的汉字字节。适配层保持原 token ID 与权重，把字节以 ASCII 传过 native 层，拼接后再解码；原始词表未修改。回归测试覆盖拆分汉字和 emoji，真实音频修复前后结果保留。来源见[依赖库实现](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-whisper-impl.h)与[同类上游问题](https://github.com/k2-fsa/sherpa-onnx/issues/3320)。

## 安装与启动

CPU 方案要求 Windows x64、Node 22.12+、`curl.exe` 和 `tar.exe`。Qwen 使用独立的 Python 3.11–3.13 环境，实测为 3.13.5；GPT 包自带 Python 3.9.13 与 Torch 2.7.0+cu128。两个 GPU 方案已在本机 RTX 50 系列验证。

从仓库根目录开始：

```powershell
cd windows/local-models
npm.cmd ci
npm.cmd run configure
& ./tools/prepare-model.ps1 -Model sensevoice
& ./tools/prepare-asr.ps1 -Model paraformer
& ./tools/prepare-asr.ps1 -Model whisper-small
& ./tools/prepare-model.ps1 -Model kokoro
node tools/start-speech-phase.mjs kokoro-82m
```

网关为 **`http://127.0.0.1:19380/v1`**。配置、权重和样音保存在被 Git 忽略的 `windows/.local/local-models/`。首次 `configure` 创建配置，重跑不会覆盖已有设置。旧 0.1.0 配置中的 Paraformer/Whisper 是预留 HTTP 服务；升级时按 `config.example.json` 添加原生协议与模型路径，保留自己的音色设置。

在另一个 PowerShell，同样进入 `windows/local-models/`，先生成测试参考样音，再准备 GPU 模型：

```powershell
node tools/smoke.mjs --tts-model kokoro-82m --voice 3
& ./tools/prepare-gpt-sovits.ps1
& ./tools/prepare-qwen.ps1
```

GPT 官方整合包下载为 8.84 GB，解压约 15 GB；Qwen 权重与 tokenizer 合计 2.51 GB，另需 Torch 及依赖空间。脚本校验固定版本、文件长度及 SHA256。GPT 使用便携 7-Zip，CPU 模型在 staging 完整验证后安装；已有损坏资源会保留备份。保留各模型的许可证与模型卡，[SenseVoice 权重条款](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)与软件许可分别核对。

生成参考样音后，先用 Ctrl+C 结束 Kokoro，再逐个启动 GPU 方案。每次只保留一个模型进程：

```powershell
# 当前目录 windows/local-models/
node tools/start-speech-phase.mjs gpt-sovits
# Ctrl+C 结束上一项后，才能启动下一项：
node tools/start-speech-phase.mjs qwen3-tts-0.6b
```

GPT 监听 `127.0.0.1:9880`，Qwen 监听 `127.0.0.1:8093`。Qwen 固定测试音色为 `pet-reference`，参考路径与原文只在启动时配置；默认参考为 `samples/kokoro-smoke.wav`。使用自己的参考时传 `--reference C:/voices/ref.wav --reference-text '录音原文' --reference-kind user-provided`。

在 `config.local.json` 中将 `qwen-tts.enabled` 设为 `true`。以官方预训练 GPT 做运行验证时，将 `gpt-sovits.voices` 的值设为：

```json
{
  "pet-smoke": {
    "refAudioPath": "samples/kokoro-smoke.wav",
    "promptText": "你好，今天我们一起测试本地语音。",
    "promptLanguage": "zh",
    "textLanguage": "zh"
  }
}
```

重启网关后运行 `npm.cmd run doctor`。模型目录表示已配置的模型；doctor 核对文件及服务，真实推理用下方验证脚本。若系统拒绝 PowerShell 脚本，可对单条命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/prepare-asr.ps1 -Model paraformer`，无需改变全局脚本策略。

## GPT-SoVITS 微调音色

GPT-SoVITS 仍是主 TTS。使用自己微调时匹配的安装与版本，在其目录启动 `api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`，再配置音色：

```json
{
  "pet": {
    "refAudioPath": "C:/AAAAGENT-voices/reference.wav",
    "promptText": "参考音频中实际说出的原文。",
    "promptLanguage": "zh",
    "textLanguage": "zh",
    "gptWeightsPath": "C:/GPT-SoVITS/GPT_weights/your-voice.ckpt",
    "sovitsWeightsPath": "C:/GPT-SoVITS/SoVITS_weights/your-voice.pth"
  }
}
```

参考 WAV 为 3–10 秒。若权重在后端 YAML 固定，所有音色均可省略权重字段；若按音色切换，所有音色都应有完整权重对。添加自己的动态音色时，替换上面的 stock `pet-smoke` 项，或也为它配置完整 stock 权重对。配置修改后重启网关。

适配器按[官方原生 API](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)串行执行权重选择与完整合成；客户端取消后，实际后台操作结束才释放锁。后台硬超时后需重启 GPT API 和网关，重新确认全局权重状态。启动器的默认 v2Pro stock 配置独立保存；已有微调配置可用 `-ConfigPath` 指定。

## OpenAI 语音接口

| 接口 | 已实现范围 |
| --- | --- |
| `GET /v1/models`、`GET /health` | 已启用的模型及网关版本；就绪检查见 doctor。 |
| `POST /v1/audio/transcriptions` | multipart `model/file/language/response_format`；三种 ASR 支持 `json/text/verbose_json`。 |
| `POST /v1/audio/speech` | JSON `model/input/voice/response_format/speed`，返回二进制音频。 |

ASR 上传 PCM16 单声道 WAV，8–48 kHz；SenseVoice/Paraformer 每段最多 60 秒，Whisper 最多 29 秒，留出余量避免依赖库在 2950 mel 帧处截掉末尾语音。由调用端用 VAD 分段，三条路径按整句识别，不提供逐 token 流式 ASR。

GPT 测试音色为 `pet-smoke`，自己的音色为 `pet`；Kokoro 示例 `voice="3"`；Qwen 为 `pet-reference`。统一验证 WAV：GPT 为 32 kHz，Kokoro/Qwen 为 24 kHz，调用端应读取 WAV 头。GPT 还适配 OGG/AAC，取决于后端编码器；其裸 PCM 被拒绝，以免与 OpenAI 的 24 kHz PCM 约定混淆。Qwen 只接受 WAV、速度 1、非流式、最多 300 字，不接收客户端参考路径或权重字段。

```powershell
curl.exe http://127.0.0.1:19380/v1/audio/transcriptions `
  -F 'model=paraformer-zh' -F 'language=zh' -F 'file=@C:/audio/recording.wav'
$speech = @{ model='gpt-sovits'; input='你好，今天我们一起测试本地语音。'; voice='pet-smoke'; response_format='wav' } | ConvertTo-Json
Invoke-WebRequest -Uri http://127.0.0.1:19380/v1/audio/speech -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($speech)) -OutFile sample.wav
```

OpenAI SDK 可将 `base_url` 设为网关地址、`api_key="local"`，并显式选择模型与 WAV。占位 key 不转发给后端。接口是[OpenAI 转写](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/transcriptions/methods/create)与[语音合成](https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create)的常用子集。

## 复测与审核

```powershell
npm.cmd test
npm.cmd run doctor
node tools/start-speech-phase.mjs gpt-sovits --verify
# 上一条退出并释放资源后，再运行下一条。
node tools/start-speech-phase.mjs kokoro-82m --verify
node tools/start-speech-phase.mjs qwen3-tts-0.6b --verify
node tools/start-speech-phase.mjs sensevoice-small --verify
node tools/start-speech-phase.mjs paraformer-zh --verify
node tools/start-speech-phase.mjs whisper-small --verify
node tools/start-speech-phase.mjs gpt-sovits
# 仅在已配置个人音色 pet 时，在另一个终端调用：
node tools/smoke.mjs --tts-model gpt-sovits --voice pet --output ../.local/local-models/samples/my-voice.wav
```

上述单模型命令经当前桌宠适配器生成三条中文的九份 WAV，再逐个 ASR 回转写，并记录延迟与资源采样。结果在 `.local/local-models/reports/desktop-20261010/`，重复执行会覆盖对应模型的报告与样音。启动器在进程启动前独占锁定，并在验证结束后释放自己创建的模型服务。旧矩阵脚本 `verify:speech` 保留用于历史复测，需要手动管理后端；本机审核使用上述单模型命令。

23 项协议/取消/字节回归通过。10 月 1 日的 Qwen 错误请求、真实取消及“本地 ASR → DeepSeek 云端对话 → Kokoro”证据保留；10 月 10 日新增三种 ASR、三种 TTS 经当前桌宠适配器的真实推理。个人微调音色、实体麦克风/扬声器和云端完整交互仍需现场验证。

MiniMax 原生云端 `speech-2.8-turbo/hd` 的 hex 音频适配保留，默认关闭；原桌宠百炼托管 MiniMax 配置继续可用。它未计入三种本地 TTS，本次没有调用付费云端语音。通用 OpenAI/Ollama 对话接口保留，**所有本地对话提供方默认关闭**。

## English

This speech module is an **unpublished local candidate**, 0.2.0-dev.1, integrated with Windows desktop pet 0.3.0-dev.1. Cloud dialogue remains configured separately. The latest application adapter, configuration commands and October 10 measurements are documented in [Windows adaptation](../docs/WINDOWS-20261010.md).

Three CPU ASR models run natively: SenseVoice Small, Paraformer and Whisper-small int8. The Whisper adapter preserves split UTF-8 bytes through sherpa's per-token filtering; weights and original token IDs stay unchanged. Three real TTS models run: primary GPT-SoVITS v2Pro on CUDA, Kokoro on CPU, and Qwen3-TTS 0.6B Base on native Windows CUDA/SDPA. No WSL or FlashAttention extension is required for the tested setup.

Follow the PowerShell commands above and configure the reference voices. Use `start-speech-phase.mjs MODEL` to run exactly one model; stop it before choosing another. The launcher checks free RAM/VRAM, refuses overlapping speech phases or a loaded Ollama model, and stops its own processes on exit. The endpoint is `http://127.0.0.1:19380/v1`. ASR accepts mono PCM16 WAV; choose WAV explicitly for TTS. The Qwen service accepts only its fixed voice, speed 1, non-streaming output and up to 300 characters.

Run `npm.cmd test`, `npm.cmd run doctor` and the sequential `--verify` commands above. Nine synthesized clips and 27 ASR round trips completed; the byte-loss regression is fixed. Reports retain observed transcription mistakes. Weights, environments, configurations and evidence stay under ignored `windows/.local/`. Tests used synthetic references and stock GPT/Qwen weights; the user's fine-tuned voice and physical devices still require separate evaluation. Publishing remains pending human review.
