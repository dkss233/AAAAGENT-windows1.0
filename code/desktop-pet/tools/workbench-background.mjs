#!/usr/bin/env node
import { openLocalUrl } from '../dist/core/open-url.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { trialFiles, verifyTrialRuntime, preparedWorkbenchEnvironment } from '../dist/app/trial-launcher.js';
import { T3LocalService } from '../../workbench/integration/t3-local-service.mjs';
import { T3HttpClient } from '../../workbench/integration/t3-http-client.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  const action = process.argv[2] ?? 'open';
  if (!['start','status','open','stop'].includes(action) || action === 'stop' && process.argv[3] !== '--confirm-stop-tasks') {
    throw Error('使用 start、status、open；停止工程后台会结束运行任务，须使用 stop --confirm-stop-tasks。');
  }
  const files = trialFiles(root), config = await readActiveTrialConfiguration(files.configFile, files.activationFile);
  if (action === 'start' || action === 'open') await verifyTrialRuntime(config);
  const env = await preparedWorkbenchEnvironment(config);
  const service = new T3LocalService({ sourceDir: env.AAAAGENT_T3_PREPARED_DIR, nodeExecutable: env.AAAAGENT_T3_NODE_EXECUTABLE,
    baseDir: resolve(root,'.local/data/t3-home'), logFile: resolve(root,'.local/data/logs/t3-workbench.log'),
    ...(env.AAAAGENT_ENGINE_PROJECT_ROOT ? { engineProjectRoot:root,
      dshWebLogPath:configurationDshLog(config.projectRoot) } : {}) });
  if (action === 'stop') { await service.stopBackground(); process.stdout.write('工程后台停止请求已送达。\n'); }
  else if (action === 'status') { process.stdout.write(JSON.stringify(await service.status()) + '\n'); }
  else {
    await service.start();
    if (action === 'open') {
      const descriptor = await new T3HttpClient(service).environmentDescriptor();
      const entry = await service.openBrowser({ kind:'home', environmentId:descriptor.environmentId });
      await openLocalUrl(entry.url);
    }
    process.stdout.write('同一个工程后台已运行；关闭桌宠或浏览器不会停止工程任务。\n');
  }
} catch { process.stderr.write('工程后台未完成操作。请核对当前安装及已有服务；停止须显式加 --confirm-stop-tasks。不会另起空实例。\n');process.exitCode=1; }

function configurationDshLog(projectRoot) { return resolve(projectRoot,'.local/data/engine-home/dsh-web.log'); }
