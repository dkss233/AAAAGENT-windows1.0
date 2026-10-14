# Windows 固定引擎与 T3 工作台

本目录支持 Windows x64，固定 Codex 0.160.0、DeepSeek Harness 0.2.0-rc.2、Node 24.13.1、npm 11.8.0。T3 上游基线为 `c13f7d93fff0f578886985a3f673b4b21b7f6ac8`，项目修改随 `windows/t3-source/` 提供；打包后的源码和运行文件由 SHA-256 清单校验。

以下命令用于全新克隆，从 `AAAAGENT/windows` 目录在 PowerShell 执行。先安装可从命令行运行的 Node.js 22 或更新版本；这个全局 Node 只负责首次下载和校验固定引擎。Windows 需要可用的 `curl.exe`、`tar.exe` 和网络连接。后续构建使用下载得到的固定 Node，不需要全局安装 Codex、DSH 或 pnpm。

```powershell
$projectRoot = $PWD.Path
node --version
node code/workbench/integration/engine-pins/prepare.mjs $projectRoot
if ($LASTEXITCODE -ne 0) { throw '固定引擎准备失败' }

# 路径由当前锁文件导出；不要假设存在另一个 toolchain 目录。
$engineDirectory = node --input-type=module -e "import {engineDirectory} from './code/workbench/integration/engine-pins/runtime.mjs'; process.stdout.write(engineDirectory);"
if ($LASTEXITCODE -ne 0) { throw '无法读取引擎目录' }
$engineRoot = Join-Path $projectRoot $engineDirectory
$node = Join-Path $engineRoot 'node/node.exe'
$npm = Join-Path $engineRoot 'node/node_modules/npm/bin/npm-cli.js'
$env:PATH = (Split-Path $node) + [IO.Path]::PathSeparator + $env:PATH
& $node --version
```

`prepare.mjs` 下载并校验锁定归档、安装固定 DSH 依赖和项目补丁，再验证完整引擎清单。已经存在的引擎目录只能通过校验后复用。实际 Node 路径为 `runtime.mjs` 导出的 `engineDirectory` 下的 `node/node.exe`。

先构建桌宠共享模块，供 profile、ACL 和工作台启动器使用：

```powershell
Push-Location (Join-Path $projectRoot 'code/desktop-pet')
try {
  & $node $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw '桌宠依赖安装失败' }
  & $node $npm run build
  if ($LASTEXITCODE -ne 0) { throw '桌宠共享模块构建失败' }
} finally { Pop-Location }
```

再用 pnpm 11.10.0 安装 T3 依赖，顺序构建 server 和普通 web。构建限制单次 Node 堆内存为 4096 MiB；避免与本地语音或语言模型同时运行。若原生依赖没有匹配的预编译文件，按安装报错补齐 Visual Studio C++ Build Tools 和 Python 后重试。

```powershell
$previousNodeOptions = $env:NODE_OPTIONS
$previousNativeRead = $env:VITE_AAA_NATIVE_READ
$env:NODE_OPTIONS = '--max-old-space-size=4096'
Remove-Item Env:VITE_AAA_NATIVE_READ -ErrorAction SilentlyContinue
Push-Location (Join-Path $projectRoot 't3-source')
try {
  & $node $npm exec --yes --package=pnpm@11.10.0 -- pnpm install --frozen-lockfile --child-concurrency=1
  if ($LASTEXITCODE -ne 0) { throw 'T3 依赖安装失败' }
  & $node $npm exec --yes --package=pnpm@11.10.0 -- pnpm --filter t3 build:bundle
  if ($LASTEXITCODE -ne 0) { throw 'T3 server 构建失败' }
  & $node $npm exec --yes --package=pnpm@11.10.0 -- pnpm --filter @t3tools/web build
  if ($LASTEXITCODE -ne 0) { throw 'T3 web 构建失败' }
} finally {
  Pop-Location
  $env:NODE_OPTIONS = $previousNodeOptions
  $env:VITE_AAA_NATIVE_READ = $previousNativeRead
}
```

确认生成 `t3-source/apps/server/dist/bin.mjs` 和 `t3-source/apps/web/dist/index.html` 后，打包运行文件并首次安装隔离 profile：

```powershell
& $node code/workbench/integration/engine-pins/package-windows-t3.mjs
if ($LASTEXITCODE -ne 0) { throw 'T3 运行包生成失败' }
& $node code/desktop-pet/tools/engine-pins/install.mjs --new-isolated-home .local/data/t3-home
if ($LASTEXITCODE -ne 0) { throw '隔离 profile 安装失败' }
```

首次打包要求 `artifacts/runtime/engine-pin-54/t3-runtime` 不存在。打包工具复制已构建的 server、普通 web 和已安装依赖，生成运行标记，并更新 `windows-t3-source.json` 与 `t3-adapter-source.json` 中的本次构建指纹；它不会安装依赖。以后仅修改 server 并重新构建时，可运行 `package-windows-t3.mjs --refresh-server`，保留已打包的普通 web。普通工作台不能使用以 `VITE_AAA_NATIVE_READ=1` 构建的 `/native/` 网页。

隔离 profile 位于 `artifacts/runtime/engine-profile.json`；引擎账户目录在 `.local/data/engine-home`，T3 数据目录在 `.local/data/t3-home`。安装器只用于首次创建新 profile，不覆盖已有 home，也不复制账户、密钥或旧会话。需要使用的执行器应在这些隔离账户目录中完成自己的登录或凭据配置。桌宠正式激活还需运行其配置与激活流程，生成匹配当前运行文件的指纹。

```powershell
& $node code/workbench/integration/engine-pins/windows-review.mjs start
& $node code/workbench/integration/engine-pins/windows-review.mjs open
& $node code/workbench/integration/engine-pins/windows-review.mjs status
& $node code/workbench/integration/engine-pins/windows-review.mjs stop --confirm-stop-tasks
```

`start` 保留后台，关闭浏览器不会终止任务；`open` 创建短期本机配对入口并打开浏览器。状态快照保存在私有目录 `.local/data/workbench-review/status.json`。`stop` 明确结束当前 profile 的 T3/DSH 进程及其所属引擎子进程。未知租约不会被自动抢占，失败的任务不会自动重发。

Windows Codex 桌面 App 的私有共享 owner 协议及原生 UI 跳转尚未验证；独立 app-server 的同 SID 恢复不能视为 App 同时双向写入能力。`probe.mjs ENGINE_ROOT EVIDENCE_DIR` 用于无模型协议检查；`windows-live-check.mjs` 会发送实际模型请求，适用于明确授权的隔离验收。`windows-native-resume-check.mjs RUN_DIR` 仅接受已停止 T3 且已完成两轮的隔离 Codex 记录。
