import Database from 'better-sqlite3';
import { isPrivateFileSync } from '../../dist/core/platform-files.js';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNativeExecutionBinding } from './execution-binding.mjs';
import { createNativeExecutionGate } from './execution-gate.mjs';
import { createScenarioPolicy } from './scenario-policy.mjs';
import { readCodexSharedConnection } from '../../../workbench/integration/codex-shared-connection.mjs';

/** Fixed-driver paths verified through the original SDK, native projections and complete renderer. */
export const DAILY_EXECUTION_PROVIDERS = Object.freeze([
  { providerInstanceId: 'codex', send: true, continue: true, modelSelection: true,
    runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'], attachments: { file: true, image: true, maxBytes: 50 * 1024 * 1024 },
    interrupt: true, approval: true, userInput: true },
  { providerInstanceId: 'dsh', send: true, continue: true, modelSelection: true,
    runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'], attachments: { file: true, image: true, maxBytes: 50 * 1024 * 1024 },
    interrupt: false, approval: true, userInput: true },
]);

function originalDatabase(file) {
  if (realpathSync(file) !== file || !isPrivateFileSync(file))
    throw Error('Original execution database identity unavailable');
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** One existing daily backend owns admission metadata; all execution remains in its original T3 host. */
export async function openDailyExecutionGate({ projectRoot, codexHome, client, providers = DAILY_EXECUTION_PROVIDERS }) {
  if (realpathSync(projectRoot) !== projectRoot || realpathSync(codexHome) !== codexHome)
    throw Error('Canonical original execution homes required');
  const { environmentId } = await client.environmentDescriptor();
  const database = originalDatabase(resolve(projectRoot, '.local/data/t3-home/userdata/state.sqlite'));
  const nativeFile = resolve(codexHome, 'state_5.sqlite');
  try {
    const admissionFile = resolve(projectRoot, '.local/data/native-web-admission.json');
    const binding = createNativeExecutionBinding({ environmentId, database,
      readSharedCodexConnection: nativeSessionId => readCodexSharedConnection(projectRoot, codexHome, { nativeSessionId }),
      readAdmission() {
        if (!existsSync(admissionFile)) return null;
        const stat = lstatSync(admissionFile);
        if (!isPrivateFileSync(admissionFile, stat)) return null;
        return JSON.parse(readFileSync(admissionFile, 'utf8'));
      },
      readCodexMetadata(nativeId) {
        if (!existsSync(nativeFile)) return null;
        const native = originalDatabase(nativeFile);
        try { return native.prepare('SELECT * FROM threads WHERE id=? AND archived=0').get(nativeId); }
        finally { native.close(); }
      } });
    async function verifyEnvironment() {
      if ((await client.environmentDescriptor()).environmentId !== environmentId) throw Error('Original environment changed');
    }
    const gate = createNativeExecutionGate({ environmentId, providers,
      file: resolve(projectRoot, '.local/data/native-web-admission.json'),
      admissionPolicy: createScenarioPolicy({file:resolve(projectRoot,'.local/data/web-scenario-execution.json'),environmentId,
        sourceRevision:JSON.parse(readFileSync(resolve(projectRoot,'.local/model-evaluation/trial/user-trial/config.json'),'utf8')).sourceRevision}),
      async getTarget(threadId) { await verifyEnvironment(); return binding.getTarget(threadId); },
      async prepareCommand(command) {
        await verifyEnvironment();
        const target = binding.prepareCommand(command);
        if (!target || target.readonly || !['thread.create', 'thread.turn.start'].includes(command.type)) return target;
        const choice = command.modelSelection ?? command.bootstrap?.createThread?.modelSelection ?? target.modelSelection;
        if (!choice || choice.instanceId !== target.providerInstanceId || typeof choice.model !== 'string')
          return { ...target, validationError: 'model_selection_unavailable' };
        const catalog = await client.providerModels(choice.instanceId);
        const provider = catalog.providers.find(item => item.instanceId === choice.instanceId);
        if (!provider?.enabled || !provider.installed || provider.authStatus !== 'authenticated' ||
            !['ready', 'warning'].includes(provider.status)) return { ...target, validationError: 'provider_unavailable' };
        const model = provider.models.find(item => item.id === choice.model);
        if (!model) return { ...target, validationError: 'model_selection_unavailable' };
        const options = Array.isArray(choice.options) ? choice.options : Object.entries(choice.options ?? {}).map(([id,value])=>({id,value}));
        const efforts = options.filter(option => option.id === 'reasoningEffort');
        if (efforts.length > 1 || efforts.length && !model.reasoningEfforts?.some(option => option.id === efforts[0].value))
          return { ...target, validationError: 'reasoning_unavailable' };
        return target;
      },
      async findReceipt(commandId) { await verifyEnvironment(); return binding.findReceipt(commandId); } });
    return { gate, close() { database.close(); } };
  } catch (error) { database.close(); throw error; }
}
