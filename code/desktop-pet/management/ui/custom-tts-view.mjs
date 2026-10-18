// Console panel for an operator-defined OpenAI-compatible TTS supplier.
//
// The reviewed catalogue is a closed list, so without this the only way to add a supplier was editing
// config.json by hand. The full request URL is shown before anything is submitted, because the saved
// API key is sent to exactly that address — the operator has to be able to see where it goes.
import { el, card, button, field, notice } from './dom.mjs';

const FIELDS = [
  ['provider', '服务商名称', '小写字母、数字、下划线或连字符，例如 siliconflow'],
  ['baseUrl', '服务地址（BaseURL）', '必须指向 /v1，例如 https://api.siliconflow.cn/v1'],
  ['model', '模型名称', '例如 FunAudioLLM/CosyVoice2-0.5B'],
  ['voice', '音色名称', '例如 alex'],
  ['credentialRef', 'API Key 引用', '在「凭据」里保存 Key 后显示的引用 ID'],
];

export function createCustomTtsView(client, render, host) {
  let data = null, draft = {}, busy = false, message = '', error = '', loaded = false;
  const load = async () => {
    busy = true; error = ''; render();
    try { data = await client.request('/api/tts/custom'); draft = data.configured
      ? { provider: data.provider, baseUrl: data.baseUrl, model: data.model, voice: data.voice, credentialRef: '' }
      : { ...(draft.provider ? draft : {}) }; }
    catch (e) { error = e.message; }
    finally { busy = false; loaded = true; render(); }
  };
  const save = async () => {
    if (busy) return;
    busy = true; error = ''; message = ''; render();
    try {
      const result = await client.request('/api/tts/custom', { method: 'PUT', body: {
        provider: (draft.provider ?? '').trim(), baseUrl: (draft.baseUrl ?? '').trim(),
        model: (draft.model ?? '').trim(), voice: (draft.voice ?? '').trim(),
        credentialRef: (draft.credentialRef ?? '').trim() } });
      message = '已保存。重启桌宠后生效；请在「语音合成 TTS」里选择「自定义语音」。';
      data = { ...(data ?? {}), configured: true, requestUrl: result.requestUrl,
        provider: draft.provider, model: draft.model, voice: draft.voice };
    } catch (e) { error = e.message; }
    finally { busy = false; render(); }
  };
  const clear = async () => {
    if (busy) return;
    busy = true; error = ''; message = ''; render();
    try { data = await client.request('/api/tts/custom', { method: 'DELETE' });
      message = '已清除，回到已登记的服务商。重启后生效。'; draft = {}; }
    catch (e) { error = e.message; }
    finally { busy = false; render(); }
  };

  return {
    view() {
      if (!loaded && !busy) void load();
      const configured = data?.configured === true;
      const set = (key, value) => { draft[key] = value; render(); };
      const requestUrl = (draft.baseUrl ?? '').trim().replace(/\/$/, '') + '/audio/speech';
      return card('自定义语音服务商',
        el('p', { class: 'subtle' }, '接入任意 OpenAI 兼容的语音合成服务。项目只向下面这个地址发送请求，除此之外不会联系其他服务商。'),
        configured && el('p', {}, el('strong', {}, '当前已配置：'), data.provider + ' · ' + data.model + ' · ' + data.voice),
        configured && el('p', { class: 'subtle' }, '实际请求地址：' + data.requestUrl),
        error && notice(error, 'warning'),
        message && notice(message, 'success'),
        el('div', { class: 'form-grid' }, ...FIELDS.map(([key, label, hint]) =>
          field(label, 'custom-tts-' + key, draft[key] ?? '', v => set(key, v), { hint }))),
        el('p', { class: 'subtle' },
          '保存后请求地址将是：', el('strong', {}, draft.baseUrl ? requestUrl : '（请先填写服务地址）')),
        el('p', { class: 'subtle' },
          '⚠ 合成时会把该 API Key 发送到上面这个地址。请确认它是你信任的服务商；只允许 http/https、不允许内嵌用户名密码、查询串或 /v1 之外的路径。'),
        el('div', { class: 'actions' },
          button(busy ? '处理中…' : '保存自定义服务商', () => void save(), { id: 'custom-tts-save', disabled: busy }),
          configured && button('清除自定义服务商', () => void clear(), { id: 'custom-tts-clear', disabled: busy })));
    },
    available: () => true,
    activate: () => { if (!loaded) void load(); },
    deactivate: () => {},
  };
}
