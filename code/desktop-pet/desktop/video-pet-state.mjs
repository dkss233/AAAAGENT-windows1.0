// Semantic compatibility with the drawing adapter and the existing presentation contract.
// IDs refer to the private catalog; model text can never supply a resource URL.
export const presetActions = Object.freeze({
  'exp-zzz': 'rest', 'exp-qianqing': 'listening', 'exp-tushe': 'happy',
  'exp-kuku': 'sad', 'exp-shoupengxing': 'encourage', 'exp-wuxiongkou': 'affectionate',
  'exp-wuyu': 'dejected', 'exp-xingxingyan': 'happy', 'exp-bixin': 'affectionate',
  'exp-aixinyan': 'heart-eyes', 'exp-shengqi': 'angry', 'exp-baiyan': 'dark-face',
  'exp-xuanyun': 'curious', 'exp-qidao': 'thanks', 'exp-lianhong': 'heart-eyes',
  'exp-lianhei': 'dark-face', 'exp-heiyan': 'dark-face',
});
export function replyAction(expression = {}, enabledIds = null) {
  if (Object.hasOwn(expression, 'presetId')) {
    return (!enabledIds || enabledIds.has(expression.presetId)) && presetActions[expression.presetId] || 'idle';
  }
  const action = ({ heart: 'affectionate', comfort: 'affectionate', hold_star: 'encourage', lean: 'listening' })[expression.gesture]
    ?? ({ happy: 'happy', sad: 'sad', warm: 'affectionate', angry: 'angry', surprised: 'heart-eyes' })[expression.emotion] ?? 'idle';
  if (enabledIds && !Object.entries(presetActions).some(([id, mapped]) => mapped === action && enabledIds.has(id))) return 'idle';
  return action;
}
export function workAction(kind, state) {
  const focused = state?.focus?.task;
  const phase = kind === 'work' ? state?.stage : focused?.id ? state?.tasks?.find(row => row.task?.id === focused.id && row.task?.projectId === focused.projectId)?.projection?.phase : undefined;
  return ({ classifying: 'thinking', clarifying: 'waiting', selecting: 'waiting', confirming: 'waiting', sending: 'working',
    working: 'working', recorded: 'waiting', accepted: 'working', running: 'working', waiting_approval: 'waiting',
    waiting_answer: 'waiting', completed: 'success', failed: 'error', unknown: 'waiting' })[phase] ?? 'idle';
}
export function catalogEntries(catalog) {
  const entries = new Map();
  const videos = new Map((catalog.nativeActions ?? []).map(item => [item.video, item]));
  for (const item of [...catalog.nativeActions ?? [], ...catalog.actions ?? [], ...catalog.workStates ?? [], ...catalog.memes ?? []]) {
    const file = item.kind === 'meme' ? item.file : videos.get(item.video)?.file;
    if (typeof item.id !== 'string' || typeof file !== 'string' || !/^assets\/(?:webm\/[^/\\:]+\.webm|memes\/[^/\\:]+\.png)$/.test(file) || file.includes('..')) continue;
    entries.set(item.id, { ...item, file });
  }
  return entries;
}
