# Windows validation

## 2026-10-10 Windows 0.3.0-dev.1 — unpublished

最新代码、视频/Live2D、3 ASR + 3 TTS、延迟及资源采样见 [本次适配与验证](docs/WINDOWS-20261010.md)。本次实测与下方历史结果分开记录；旧段落的“尚未集成”描述仅对应当时版本。

<a id="2026-10-01-local-speech"></a>
## 2026-10-01 Local speech — 0.2.0-dev.1, unpublished local candidate

Tested on native **Windows 11 x64 / Ryzen 7 9700X / Node 22.14.0 / sherpa-onnx-node 1.13.8**, 31 GiB RAM and RTX 5070 Ti 16 GiB, driver 591.86. SenseVoice, Paraformer, Whisper and Kokoro run on CPU. GPT-SoVITS and Qwen run on native Windows CUDA, without WSL. The existing pet stays at 0.1.2 and uses cloud dialogue; its UI/provider schema has not yet been connected to this separate gateway.

This candidate is local and awaits human review. The earlier preparation commit was reverted on GitHub; no new candidate was published.

| Real model | Observed result |
| --- | --- |
| SenseVoice Small int8 | Official 5.592 s Chinese recording and all 9 TTS clips transcribed. Warm short requests 40–64 ms. Official sample says `开饭时间早上9点至下午5点。`, with a homophone error for `开放`. |
| Paraformer int8 | Official Chinese recording and all 9 TTS clips transcribed. Warm short requests 34–45 ms. One GPT clip says `本店语音` for `本地语音`. |
| Whisper-small int8 | Official recording and all 9 TTS clips transcribed after fixing UTF-8 byte loss. Warm short requests 573–899 ms. May use traditional Chinese; one Qwen clip says `本地語言` for `本地语音`. |
| GPT-SoVITS v2Pro stock | 3 Chinese sentences, 32 kHz mono PCM16 WAV, 3.90–4.80 s audio. Warm HTTP synthesis 1056–1598 ms. First reference processing/synthesis took 35323 ms. Bundled Python 3.9.13 / Torch 2.7.0+cu128. |
| Kokoro 82M int8 voice 3 | 3 sentences, 24 kHz mono PCM16 WAV, 3.358–4.752 s audio. HTTP synthesis 2174–3300 ms. |
| Qwen3-TTS 0.6B Base | 3 sentences, 24 kHz mono PCM16 WAV, 3.04–4.56 s audio. HTTP synthesis 6058–8209 ms. Python 3.13.5 / Torch and Torchaudio 2.8.0+cu128 / qwen-tts 0.1.1 / Transformers 4.57.3, bfloat16 + SDPA. |
| Existing cloud dialogue bridge | One real local ASR → DeepSeek `deepseek-flash` → local Kokoro check returned `收到，本地语音测试正常。`. Cloud request 624 ms, 41 input + 7 output tokens. Local dialogue stayed disabled. |

Three phrases produced **9 real non-silent WAV files**, each recognized by all three ASR models: **27 round trips**, plus one official recording through each recognizer. All returned successfully. This is a small synthetic sample, not a speech-accuracy benchmark. GPT/Qwen used the existing 3.36 s Kokoro clip as a synthetic reference, with stock pretrained weights; the user's fine-tuned voice is not covered.

### Bug found and fixed

Whisper originally returned `你好,今天我们一起本地音。` for `你好，今天我们一起测试本地语音。`. Its result contained empty BPE tokens at the missing characters. Full-precision weights and different tail padding reproduced the same problem.

In [sherpa 1.13.8's Whisper conversion](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-whisper-impl.h), normalization runs on each byte token. The [normalizer](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-impl.cc) removes incomplete UTF-8 sequences. Chinese characters can span multiple BPE tokens, so this deletes correctly predicted bytes before concatenation. A [matching upstream report](https://github.com/k2-fsa/sherpa-onnx/issues/3320) exists.

The Windows adapter creates a derived ASCII byte vocabulary with the same token IDs and decodes joined bytes in JavaScript. Original weights and token files stay unchanged. After the fix, the same clip returns `你好,今天我們一起測試本地語音。`; the previously missing words in all three phrases are retained. Simplified/traditional spelling and ordinary recognition errors remain visible in the raw results.

Whisper's native 2950-frame cutoff could also silently truncate the end of a nominal 30-second clip. The adapter caps each request at 29 seconds and returns an actionable error for longer audio; clients should segment with VAD. A real 30-second gateway upload returned HTTP 400 in 24 ms, with no native decoding. Real text-format requests through all three ASR routes also passed after the final restart.

| Additional check | Result |
| --- | --- |
| Native Windows unit/protocol regressions | 23 passed, 0 failed: aliases, upstream credentials, formats, bounds, native cancellation, GPT global-weight serialization/timeouts and split UTF-8 bytes. Mock HTTP cases are separate from real inference. |
| Qwen real invalid requests | 10 rejected with HTTP 400: reference paths/URLs, weights, unknown voice, streaming, MP3, speed, long/blank input. |
| Qwen real client cancellation | GPU lock remained busy after disconnect, a second request returned 503, and the lock cleared after actual inference completed. |
| Installer checks | All model downloads passed pinned length/SHA256 checks. ASR and Qwen preparation reruns verified files; GPT archive paths/extraction and critical-file manifest rerun verified. CPU installer corruption recovery passed in an isolated directory. |
| Current gateway | `127.0.0.1:19380/v1`, version `0.2.0-dev.1`, 3 ASR + 3 TTS routes. Doctor reports model files and both native GPU APIs ready. |
| MiniMax native cloud speech | Protocol tests passed for hex audio and HTTP-200 errors. Default disabled; no paid speech call. |

The original WAV generation occurred at **2026-10-01 01:45 China time**. The final ASR replay at **02:01** verified every WAV's SHA256 and reran all 27 transcriptions with the fix. TTS timings belong to the original generation. Local review files are under `windows/.local/local-models/reports/speech-matrix-2026-09-30T18-01-47-984Z/`; UTC directory timestamps differ from China local time.

Other local evidence: `reports/asr-native-validation-2026-10-01.json`, `reports/whisper-quality-comparison.json`, `reports/whisper-utf8-fix-validation.json`, `qwen-validation.json`, `qwen-protocol-validation.json`, and `cloud-speech-validation.json`. These files, audio, weights, caches and environments are ignored by Git.

Reproduce using the commands in [the module guide](local-models/README.md#复测与审核). The user's fine-tuned voice, physical microphone/speaker playback and existing pet integration still need separate evaluation. Mac implementation and Mac-only documentation were not changed. Publishing requires human review of this local candidate.

<a id="2026-09-19-windows-update"></a>
## 2026-09-19 Windows update — 0.1.2

Tested locally on Windows 11 x64, Node 22.14.0, npm 10.9.2 and Electron 44.4.1. This update ports the Mac emotion feature and exercises the upstream chat-import and self-service setup changes while retaining the Windows transport, ACL and shutdown fixes.

| Check | Observed result |
| --- | --- |
| `build:windows` and resource doctor | Passed; all local resource checks true |
| Core memory/provider suite | 563 passed, 0 failed |
| `test:release` (including past-chat import) | 138 passed, 0 failed |
| `test:windows` | 22 passed, 0 failed |
| `test:setup` | 49 passed, 0 failed; four Unix-specific checks skipped |
| `test:emotion` | 27 passed, 0 failed |
| `test:emotion:ui` | One Electron/Chromium test passed, covering six scenarios; browser screenshot inspected |
| Connection, desktop-work, forwarding, native-work and HTTP relay | 64 passed, 0 failed |
| Windows stress suite | 5 passed, 0 failed |
| Real configured backend | HTTP 200; 20-character Chinese reply, 231,316 bytes of generated TTS; no runtime errors |
| Real emotion API after dialogue | HTTP 200; two persisted message snapshots, separate user/companion subjects, schema version 0.1.1 |
| Configured Electron lifecycle | Two launches ready; both clean exits left no backend lock; Live2D screenshot inspected |

The six UI scenarios cover empty/null state, independent subjects with frozen historical snapshots, rejected stale/invalid responses, escaped labels, pagination and inactive-section behavior, and refresh without polling or mutations. Tests run with the project's installed Electron and a local synthetic HTTP fixture; they need no WebKit installation, credentials or private assets.

Windows-specific test fixes close SQLite connections before deleting fixture files, use directory junctions without requiring symlink privileges, assert private-file ACLs rather than POSIX mode bits, and update provider-catalog expectations for the new voice setup. The four skips concern Unix file/directory permission or ownership behavior; Windows ACL checks run separately. Suite counts overlap and must not be added as distinct cases. The existing Windows CI workflow is retained; setup, emotion backend and Chromium checks are available as npm commands and were run locally for this release.

The first GitHub Actions run exposed an additional elevated-runner case: newly created files were owned by the Administrators token owner rather than the user SID. The Windows policy now admits that exact owner only when the current token is elevated and its default owner matches. Other owners and broad access grants remain rejected. The existing Windows tests cover this on the hosted runner. After the fix, both the 22-case Windows suite and 138-case release suite passed on GitHub Actions with Windows Server / Node 24.19.0: [verified run for 0ec5193](https://github.com/phoiex/AAAAGENT/actions/runs/35441556331). Both suites were also rerun successfully on the local machine.

An initial desktop check encountered a stale backend lock from an exited process. The PID was verified absent and the lock was backed up before retrying; personal data was retained. The subsequent real backend and both normal desktop exits succeeded. An abnormal termination can still require the documented lock recovery.

Emotion API schema version 0.1.1 is independent of application version 0.1.2. Existing data and local model appearance overrides were retained. New tables do not fabricate emotion history for earlier conversations. Runtime text assessments reuse the dialogue request; no extra background inference model is configured. These checks verify persistence and integration, not the accuracy of emotion understanding.

Reproduce from `windows/code/desktop-pet/`:

```powershell
npm.cmd run build:windows
npm.cmd test
npm.cmd run test:release
npm.cmd run test:windows
npm.cmd run test:setup
npm.cmd run test:emotion
npm.cmd run test:emotion:ui
npm.cmd run test:stress
node --test dist/tests/harness/connection.test.js dist/tests/harness/desktop-work.test.js dist/tests/harness/forwarding.test.js dist/tests/harness/native-work.test.js dist/tests/harness/relay-http.test.js
```

Live Codex and Harness dispatch results remain dated **2026-09-17** below; this update reran their 64 automated work/relay cases, not a new real executor task. Paid voice cloning was not invoked; setup uses synthetic keys/audio and local HTTP. Physical microphone/camera, live ASR, actual speaker output, wake accuracy, WeChat login/delivery and Windows ARM64 remain unverified. Private keys, model/SDK files, audio, screenshots and databases are excluded from Git.


<a id="2026-09-17-windows-reproduction"></a>
## 2026-09-17 Windows reproduction — 0.1.1

Independently reproduced on the user's Windows x64 machine using Windows Node 22.14.0, npm 10.9.2, Electron 44.4.1 and native SQLite. The external DeepSeek Harness was installed separately as `@deepseek-ai/dsh@0.1.5-rc.2` and run with Node 24.19.0. Codex was the locally installed `0.155.0-alpha.2.6` executable with the user's existing login.

| Check | Observed result |
| --- | --- |
| `build:windows` and resource doctor | Passed; all resource checks true |
| Windows suite | 22 passed, 0 failed |
| Core memory/provider suite | 525 passed, 0 failed |
| Release suite | 116 passed, 0 failed |
| Windows stress suite | 5 passed, 0 failed |
| Connection, desktop-work, forwarding and native-work suites | 63 passed, 0 failed |
| HTTP + SQLite + stdio MCP integration | 1 passed, 0 failed after restoring the missing bridge and correcting Windows cleanup |
| Configured Electron lifecycle | Two launches ready; both exits left no backend lock |
| Real configured backend | Management HTTP 200, 16-character Chinese reply and 167,786 bytes of TTS audio; no runtime errors |
| Real Codex dispatch | Confirmed task accepted; exact turn completed with `AAAAGENT_CODEX_FORWARD_OK` |
| Real DeepSeek Harness dispatch | Confirmed task accepted in a Windows project directory; exact request completed with `AAAAGENT_HARNESS_FORWARD_OK` |
| Live2D | Rendered and screenshot inspected; local rig's native appearance switch hides its watermark |

The two real task tests used the production `HarnessForwarding` prepare/confirm/receipt path, real SQLite receipts and the installed executors. They requested a short exact reply in an isolated test workspace with no tools or delegation. The Codex test exercised the official app-server JSONL transport, not a mock or Mac IPC. Harness was authenticated with the user's configured DeepSeek service. Private credentials, model assets, absolute personal paths, screenshots and runtime databases are not published.

Reproduce the work regressions after building:

```powershell
node --test dist/tests/harness/connection.test.js dist/tests/harness/desktop-work.test.js dist/tests/harness/forwarding.test.js dist/tests/harness/native-work.test.js dist/tests/harness/relay-http.test.js
```

An exploratory wildcard run also selected the retained `codex-app.test.ts` Mac Unix-socket tests. Its 12 cases cannot run on Windows (`/tmp` socket fixtures); these are not counted as passing or silently skipped. Windows transport behavior is covered separately by `tests/windows/codex.test.mjs`. No Mac source or tests outside the Windows copy were changed. Suite counts overlap and should not be added as a count of distinct tests.

Limitations: physical microphone/camera, live ASR, actual speaker playback, wake-word accuracy, WeChat login/delivery, Windows ARM64 and complex tool/approval workflows were not validated. The Windows Codex bridge declines interactive command/file approvals; continue such work in Codex. The real TTS test verified generated audio bytes, not audible output. Harness is an external engine, not bundled in the repository. See [setup and dispatch instructions](README-WINDOWS.md).

## Earlier source-author report (historical)

The following report describes the original archive before the 0.1.1 fixes. Its unsupported-Codex, remaining-test-failure and untested-provider statements are superseded by the measured results above; it is retained as provenance.

> Source-author report: the Windows-specific runtime results below were supplied with the Windows source archive. The integration review has not independently reproduced them on Windows. macOS is currently the most mature platform; report Windows problems through this repository’s Issues.


Validated locally on 17 September 2026, on Windows 11 x64 with Node 24.19.0, Electron 44.4.1 and the package's locked dependencies.

| Check | Result |
| --- | --- |
| TypeScript backend build | Passed |
| Desktop renderer and management preview build, using supplied local model/SDK | Passed |
| SQLite native module | Loaded; real database tests passed |
| Windows wake native module | Packaged and loaded; `KeywordSpotter` available |
| Windows-specific tests | 11 passed, 0 failed |
| Existing release suite | 115 passed, 0 failed |
| Existing broader suite | 520 passed, 4 existing failures |
| Actual Electron UI smoke test | Passed: Live2D load, sandboxed preload, backend ready, text round trip, visible chat panel, shutdown |
| Local resource doctor | All reported resources present in the prepared working folder |
| Follow-up synthetic stress suite | 5 passed; 2,000 requests, 250 mock conversations, 300 projects, 20,000 cancellations, 10,000 layout transitions |
| Additional task, runtime, playback and retry checks | 116 passed after Windows permission and test-fixture fixes |
| Follow-up software-rendered Electron preview | Passed; SwiftShader verified, model loaded, text round trip completed, screenshot inspected |

The Windows-specific tests cover credential DACLs (including rejecting an Everyone read grant), real credential save/reopen, drive-qualified paths, traversal and junction rejection, SQLite project persistence, multi-monitor window geometry, management-session identity checks, launch fingerprints, split UTF-8 transport, stale generations, reconnection, bounded messages, timeout and graceful backend EOF.

The four remaining broader-suite failures match the original source package's documented failures:

1. Manual-assistant evidence retention assertion.
2. Legacy combined-Omni adapter audio/image assertion.
3. Legacy combined-Omni adapter model/emotion assertion.
4. Legacy Qwen-summary format assertion.

No test was removed or skipped to make these results pass. Test fixtures now close their additional SQLite handles before deleting files on Windows. The voice-registry permission assertion checks actual file privacy on each platform, and the interleaving test uses real files so Windows ACL operations remain exercised.

Not verified: physical microphone/camera capture, live ASR/TTS, wake-word detection accuracy, authenticated cloud chat, WeChat login/delivery, external Harness dispatch, or Windows Codex task dispatch. The Mac-specific Codex IPC adapter remains unsupported on Windows. No archived credentials, chats or account sessions were activated for validation.

The local preview uses the supplied private model without changing its watermark or redistributing it. The source ZIP excludes the private rig, SDK, credentials, runtime data and dependency/build directories. See [README-WINDOWS.md](README-WINDOWS.md) for setup and development commands.

The follow-up review corrected Windows permissions on newly created task-receipt databases. Tests now verify the real Windows ACL, use directory junctions for escape checks without administrator privileges, and wait for the actual cancellation checkpoint instead of a fixed count of event-loop ticks. See [WINDOWS-STRESS-RESULTS.md](WINDOWS-STRESS-RESULTS.md). Passing application tests does not establish GPU/NPU driver stability; the follow-up preview deliberately used software rendering after the laptop's recurring driver timeouts.
