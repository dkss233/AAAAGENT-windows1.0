import { DEFAULT_SERVER_SETTINGS, ORCHESTRATION_PROTOCOL_VERSION, OrchestrationReadModel, OrchestrationShellSnapshot, OrchestrationThreadDetailSnapshot, ServerConfig, ServerSettings } from '@t3tools/contracts';
import * as Schema from 'effect/Schema';

export const ENVIRONMENT_ID = 'aaa-native-ui-example';
export const TIME = '2026-09-30T10:49:08.549Z';
const model = { instanceId: 'codex', model: 'example-model' };
export const descriptor = { environmentId: ENVIRONMENT_ID, label: 'AAAAGENT · 隔离界面示例', platform: { os: 'darwin', arch: 'arm64' }, serverVersion: '0.0.42-example', orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION, capabilities: { repositoryIdentity: true, connectionProbe: true } };
export const auth = { policy: 'loopback-browser', bootstrapMethods: ['one-time-token'], sessionMethods: ['browser-session-cookie', 'bearer-access-token'], sessionCookieName: 'aaa_preview_no_real_cookie' };
const providers = [{ instanceId: 'codex', driver: 'codex', displayName: 'Codex · 示例', enabled: true, installed: true, version: 'example', status: 'ready', auth: { status: 'authenticated' }, checkedAt: TIME, models: [{ slug: 'example-model', name: '示例模型（无调用）', isCustom: true, capabilities: null }] }];
export const config = Schema.encodeSync(ServerConfig)(Schema.decodeUnknownSync(ServerConfig)({ environment: descriptor, auth, cwd: '/example/aaaagent', keybindingsConfigPath: '/example/keybindings.json', keybindings: [], issues: [], providers, availableEditors: [], observability: { logsDirectoryPath: '/example/logs', localTracingEnabled: false, otlpTracesEnabled: false, otlpMetricsEnabled: false, otlpLogsEnabled: false }, settings: Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS), shellResumeCompletionMarker: true, threadResumeCompletionMarker: true }));
const projects = [
  { id: 'project-native-example', title: 'AAAAGENT · 原生界面', workspaceRoot: '/example/aaaagent' },
  { id: 'project-second-example', title: '另一项目 · 同名对话隔离', workspaceRoot: '/example/other' },
  { id: 'project-empty-example', title: '空项目', workspaceRoot: '/example/empty' },
].map(p => ({ ...p, defaultModelSelection: model, scripts: [], createdAt: TIME, updatedAt: TIME, deletedAt: null }));
const rows = [
  { id: 'native-chat-a', projectId: projects[0]!.id, title: '实现对话节点总览', text: '请保留原生聊天与工程组件，增加节点画布。' },
  { id: 'native-chat-b', projectId: projects[0]!.id, title: '实现对话节点总览', text: '这个同名对话有独立的准确任务 ID。' },
  { id: 'native-chat-c', projectId: projects[0]!.id, title: '验证深色外观和语音回填', text: '检查深色外观，并将模拟语音原文填入当前输入框。' },
  { id: 'native-chat-other', projectId: projects[1]!.id, title: '实现对话节点总览', text: '另一项目的独立对话。' },
];
const diff = 'diff --git a/src/flow.ts b/src/flow.ts\nindex 1111111..2222222 100644\n--- a/src/flow.ts\n+++ b/src/flow.ts\n@@ -1 +1,2 @@\n-export const view = "list";\n+export const view = "canvas";\n+export const preserveThreadIdentity = true;\n';
export const readModel = Schema.encodeSync(OrchestrationReadModel)(Schema.decodeUnknownSync(OrchestrationReadModel)({ snapshotSequence: 1, projects, updatedAt: TIME, threads: rows.map(row => ({ ...row, modelSelection: model, runtimeMode: 'approval-required', interactionMode: 'default', branch: 'example/native-ui', worktreePath: null, latestTurn: { turnId: `turn-${row.id}`, state: 'completed', requestedAt: TIME, startedAt: TIME, completedAt: TIME, assistantMessageId: `assistant-${row.id}` }, createdAt: TIME, updatedAt: TIME, deletedAt: null, session: { threadId: row.id, status: 'ready', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'approval-required', activeTurnId: null, lastError: null, updatedAt: TIME }, messages: [
  { id: `user-${row.id}`, role: 'user', text: row.text, turnId: `turn-${row.id}`, streaming: false, createdAt: TIME, updatedAt: TIME },
  { id: `assistant-${row.id}`, role: 'assistant', text: '### 原生 T3 聊天组件\n\n这段记录是**隔离界面示例**，通过原始 HTTP/RPC 形状进入原状态。\n\n```typescript\nexport const keepThread = true;\n```\n\n- Markdown、代码、差异面板仍来自固定的 T3 应用。\n- 输入框保留原草稿；发送和所有工程命令在输入层拒绝。\n\n下一步可以检查代码差异。', turnId: `turn-${row.id}`, streaming: false, createdAt: TIME, updatedAt: TIME },
], activities: [{ id: `activity-${row.id}`, kind: 'tool.call', tone: 'tool', summary: '读取 src/flow.ts（示例工具记录）', payload: { toolName: 'read_file', status: 'completed' }, turnId: `turn-${row.id}`, sequence: 1, createdAt: TIME }], checkpoints: [{ turnId: `turn-${row.id}`, checkpointTurnCount: 1, checkpointRef: 'example-checkpoint', status: 'ready', files: [{ path: 'src/flow.ts', kind: 'modified', additions: 2, deletions: 1 }], assistantMessageId: `assistant-${row.id}`, completedAt: TIME }] })) }));
export const shell = Schema.encodeSync(OrchestrationShellSnapshot)(Schema.decodeUnknownSync(OrchestrationShellSnapshot)({ snapshotSequence: 1, projects, updatedAt: TIME, threads: readModel.threads.map(t => ({ ...t, latestUserMessageAt: TIME, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false })) }));
export function threadSnapshot(id: string) {
  const thread = readModel.threads.find(t => t.id === id);
  if (!thread) throw new Error('Unknown isolated thread identity');
  return Schema.encodeSync(OrchestrationThreadDetailSnapshot)(Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)({ snapshotSequence: 1, thread }));
}
export function turnDiff(id: string) {
  threadSnapshot(id);
  return { threadId: id, fromTurnCount: 0, toTurnCount: 1, diff };
}
