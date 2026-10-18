# AAAAGENT Windows 0.3.0-dev.1

## QQ bot and companion memory · 2026-10-18

Windows now supports receipt-backed QQ summaries, companion synchronization and a login background service. Validation used six real cloud calls and zero local-model calls; QQ delivery receipts were synthetic. [Release notes](docs/WINDOWS-20261018.md) · [Setup](docs/SOCIAL_MEMORY.md) · [Architecture](../docs/ARCHITECTURE.md)

This is a **source development candidate, not a stable release or a signed installer**. It integrates video / Live2D switching, a separate T3 workbench, three ASR and three TTS options, and opt-in local foreground dialogue through Ollama. The October 10, 2026 checks include both successful paths and unresolved failures.

[中文](README.md) · [Project home](../README.en.md) · [Platform differences](../docs/PLATFORMS.md#english) · [Third-party sources and notices](THIRD_PARTY_NOTICES.md)

Windows uses the separate `windows/code/desktop-pet/` tree, an Electron window and a Node.js backend. Follow the project home for macOS. Do not share platform binaries, `node_modules`, credential paths or runtime fingerprints between the two installations.

## Getting started

For installation by a local coding agent, use the [agent runbook (中文)](AGENT_INSTALL.md) and `Install-Windows.ps1`. It installs locked dependencies, builds the app and opens first-run setup. Supply your own credentials and licensed assets. The [provider migration guide (中文)](docs/PROVIDER_MIGRATION.md) explains configuration changes versus adapter work for other cloud platforms.

Use Windows x64, Node.js 22.12 or later, and character assets and SDK components you are authorized to use. From the repository root:

```powershell
cd windows/code/desktop-pet
npm.cmd ci
npm.cmd run dev
```

Alternatively use `windows/Start-Windows.cmd`. Supply compatible assets first. The preview echoes text offline; it is not a model-backed conversation. See the [Windows installation guide](README-WINDOWS.md).

After building, `npm.cmd run configure-local` opens first-run setup. Configure your own accounts and external credentials, activate the configuration, then use `npm.cmd start`. Cloud requests may incur charges. [Local speech](local-models/README.md#english) and [local dialogue](docs/LOCAL-LLM.md) require separate explicit selections.

## What was tested

- **Desktop and workbench:** video / Live2D switching and basic Electron interaction were checked. The video pet is based on PC2005-cloud's [dsh-pet](https://github.com/PC2005-cloud/dsh-pet): its code uses MIT, while animations, prompts and source videos follow the upstream noncommercial terms. The media is not distributed here. Codex and DeepSeek Harness each completed two real file-task turns through T3 in the same session; Codex also resumed via the official app-server. This does not establish native desktop-app bidirectional synchronization or every desktop-pet UI task path.
- **Speech:** SenseVoice Small, Paraformer, Whisper-small, GPT-SoVITS, Kokoro and Qwen3-TTS ran through the application adapters. Nine synthesized clips, 27 cross-model transcriptions and three official-recording transcriptions completed. Transcription errors remain. GPT/Qwen used stock weights and synthetic references; personal fine-tuned voices, physical devices and sustained use remain unverified.
- **Local dialogue:** Qwen3.5 4B returned structured text and expressions, but twice answered `(17 * 23) + 5` as 404 instead of 396, and failed one context-recall trial. 9B was downloaded and prepared only; resource checks blocked loading and the user then cancelled testing. No 9B inference, quality or performance result is claimed.
- **Background memory:** one full-backend trial produced conflicting intent classifications: foreground admission returned `none`, while cloud strict memory returned `forget`. A same-turn assistant dependency was rejected by the source time boundary. The protection remains intact and the full trial failed. Local foreground replies do not make memory, admission, summary or the rest of the application offline.

Read the [dated Windows measurements](docs/WINDOWS-20261010.md) and [local LLM results](docs/LOCAL-LLM.md). Passing regression suites is not evidence that model quality is reliable.

## Distribution and attribution

Weights, private video / Live2D assets, reference recordings, secrets, accounts, personal databases and local review evidence are not distributed with this repository. Obtain SDK components, engines and models separately under their applicable terms.

See [setup](docs/SETUP.md#english), [memory and chat import](docs/MEMORY.md#english), the [Windows changelog](CHANGELOG-WINDOWS.md), and [third-party project references and notices](THIRD_PARTY_NOTICES.md). Original project content is governed by [LICENSE](../LICENSE); third-party content keeps its own terms and attribution. Project source: [AAAAGENT](https://github.com/phoiex/AAAAGENT).
