// Synthetic text-only requests; no cloud, microphone, speech model or tool execution.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--size=4b', '--size=9b'].includes(arg))) throw Error('Option: --size=4b|9b.');
const size = args[0]?.slice(7) ?? '4b';
const directory = fileURLToPath(new URL(`../../.local/local-models/reports/llm-20261010/${size}/`, import.meta.url));
const baseUrl = 'http://127.0.0.1:11435', model = `aaaagent-qwen35-${size}:review`;
await mkdir(directory, { recursive: true });
const report = { at: new Date().toISOString(), model, baseUrl, context: 16384,
  scope: 'One local model, synthetic text, sequential OpenAI-compatible/API requests. No tools actually executed.', results: [], failures: [] };
const user = content => ({ role: 'user', content });
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
async function metadata(path) {
  const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw Error(`Ollama metadata returned ${response.status}`);
  return response.json();
}
async function streamCase(name, messages, extra, validate) {
  const begin = performance.now(); let firstTokenMs, text = '', usage, finishReason, reasoning = '';
  const response = await fetch(baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 256,
      temperature: 0.3, seed: 42, reasoning_effort: 'none', ...extra }), signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw Error(`OpenAI stream returned ${response.status}`);
  const decoder = new TextDecoder(); let pending = '';
  function line(value) {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim(); if (!data || data === '[DONE]') return;
    const event = JSON.parse(data), delta = event.choices?.[0]?.delta;
    if (delta?.content) { firstTokenMs ??= Math.round(performance.now() - begin); text += delta.content; }
    reasoning += delta?.reasoning ?? delta?.reasoning_content ?? '';
    usage = event.usage ?? usage; finishReason = event.choices?.[0]?.finish_reason ?? finishReason;
  }
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline; while ((newline = pending.indexOf('\n')) >= 0) { line(pending.slice(0, newline).replace(/\r$/, '')); pending = pending.slice(newline + 1); }
  }
  pending += decoder.decode(); if (pending) line(pending);
  const totalMs = Math.round(performance.now() - begin);
  const result = { name, text, firstTokenMs, totalMs, usage, finishReason, reasoningCharacters: reasoning.length,
    passed: finishReason === 'stop' && reasoning.length === 0 && validate(text) };
  report.results.push(result); console.log(JSON.stringify(result));
  if (!result.passed) report.failures.push(name);
}
try {
  report.version = await metadata('/api/version');
  report.initiallyLoaded = await metadata('/api/ps');
  if (!Array.isArray(report.initiallyLoaded.models) || report.initiallyLoaded.models.length) throw Error('Cold measurement requires an empty owned server. Use start-llm-phase.mjs --verify.');
  await streamCase('cold-chinese-chat', [user('请用自然中文陪我聊一句：今天事情很多，有点累。最多两句话，不要列表，不要声称你做了现实操作。')], {}, text => /[\u4e00-\u9fff]/.test(text) && text.length >= 10 && text.length <= 240);
  await streamCase('warm-context-recall', [user('这是合成测试：我叫小林，喜欢乌龙茶，明天只计划检查代码。'), { role: 'assistant', content: '记住这轮上下文了：小林喜欢乌龙茶，明天计划检查代码。' }, user('我叫什么，喜欢喝什么？仅一句话。')], {}, text => text.includes('小林') && text.includes('乌龙茶'));
  await streamCase('structured-arithmetic', [user('只返回符合JSON schema的对象。计算 (17 * 23) + 5，把计算结果填到answer，label固定为本地计算。')], {
    response_format: { type: 'json_schema', json_schema: { name: 'arithmetic', strict: true,
      schema: { type: 'object', properties: { answer: { type: 'integer' }, label: { type: 'string' } }, required: ['answer', 'label'], additionalProperties: false } } }
  }, text => { try { const value = JSON.parse(text); return exactKeys(value, ['answer', 'label']) && value.answer === 396 && value.label === '本地计算'; } catch { return false; } });
  const begin = performance.now();
  const response = await fetch(baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [user('请调用提供的get_weather工具查询上海天气。不要猜测天气，不执行其他操作。')], stream: false, reasoning_effort: 'none', max_tokens: 256, temperature: 0,
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查询指定城市天气（本测试只验证调用参数，不实际执行）',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }] }),
    signal: AbortSignal.timeout(120000), redirect: 'error' });
  const body = await response.json(), call = body.choices?.[0]?.message?.tool_calls?.[0];
  let argumentsValue; try { argumentsValue = JSON.parse(call?.function?.arguments ?? 'null'); } catch {}
  const result = { name: 'tool-arguments-only', totalMs: Math.round(performance.now() - begin), httpStatus: response.status,
    message: body.choices?.[0]?.message, usage: body.usage, finishReason: body.choices?.[0]?.finish_reason,
    passed: response.ok && body.choices?.length === 1 && body.choices[0].finish_reason === 'tool_calls'
      && body.choices[0].message?.tool_calls?.length === 1 && call?.type === 'function' && call.function.name === 'get_weather'
      && !body.choices[0].message?.reasoning && !body.choices[0].message?.reasoning_content
      && exactKeys(argumentsValue, ['city']) && /^(上海市?|Shanghai)$/i.test(argumentsValue.city) };
  report.results.push(result); if (!result.passed) report.failures.push(result.name); console.log(JSON.stringify(result));
  const nativeStart = performance.now();
  const native = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [user('用三句话解释为什么本地小模型测试要限制上下文长度。')], stream: false, think: false,
      keep_alive: '60s', options: { num_ctx: 16384, num_predict: 192, temperature: 0.3, seed: 42 } }), signal: AbortSignal.timeout(120000), redirect: 'error' });
  const value = await native.json();
  const stats = { name: 'native-api-timing', totalMs: Math.round(performance.now() - nativeStart), text: value.message?.content,
    loadMs: Math.round(value.load_duration / 1e6), promptTokens: value.prompt_eval_count, promptMs: Math.round(value.prompt_eval_duration / 1e6),
    generatedTokens: value.eval_count, generationMs: Math.round(value.eval_duration / 1e6),
    tokensPerSecond: Math.round(value.eval_count / (value.eval_duration / 1e9) * 10) / 10,
    passed: native.ok && value.done === true && value.done_reason === 'stop' && Boolean(value.message?.content) };
  report.results.push(stats); if (!stats.passed) report.failures.push(stats.name); console.log(JSON.stringify(stats));
  const { LocalDialogueProvider } = await import('../../code/desktop-pet/dist/providers/local-dialogue.js');
  const { DEFAULT_CHARACTER_PROMPTS } = await import('../../code/desktop-pet/dist/companion/prompts.js');
  const recent = [];
  for (const [index, text] of ['你好，今天事情很多，有点累。', '我刚才说今天怎么样？用一句话回答。'].entries()) {
    const scope = { characterId: 'companion', sessionId: 'local-llm-review', turnId: `local-${index}`, generation: 1 };
    let wireUsage, wireFinish;
    const provider = new LocalDialogueProvider({ baseUrl: baseUrl + '/v1', model, contextWindowTokens: 16384,
      inputTokenLimit: 12000, outputTokenLimit: 768, reasoningEffort: 'none', temperature: 0.3 }, () => ({ presets: [] }),
    async (url, init) => { const response = await fetch(url, init); const observed = await response.clone().json();
      wireUsage = observed.usage; wireFinish = observed.choices?.[0]?.finish_reason; return response; });
    const input = { scope, text, context: { scope, characterPrompt: DEFAULT_CHARACTER_PROMPTS.companion,
      recent: [...recent], summary: '', memories: [], perception: null, inputTokenBudget: 12000 } };
    provider.prepare({ scope, text });
    const countedInput = provider.countContext(input.context, text), start = performance.now();
    const output = await provider.reply(input, AbortSignal.timeout(120000));
    const entry = { name: `desktop-provider-${index + 1}`, totalMs: Math.round(performance.now() - start),
      countedInput, usage: wireUsage, finishReason: wireFinish, output,
      passed: Boolean(output.text) && Boolean(output.expression) && (index === 0 || /累|事情.*多|忙/.test(output.text)) };
    report.results.push(entry); if (!entry.passed) report.failures.push(entry.name); console.log(JSON.stringify(entry));
    recent.push({ characterId: 'companion', id: `user-${index}`, role: 'user', text, createdAt: new Date().toISOString() },
      { characterId: 'companion', id: `assistant-${index}`, role: 'assistant', text: output.text, createdAt: new Date().toISOString() });
  }
  report.loaded = await metadata('/api/ps');
  const loaded = report.loaded.models?.[0];
  const residency = { name: 'model-residency', loadedModelCount: report.loaded.models?.length, model: loaded?.name,
    context: loaded?.context_length, allocatedBytes: loaded?.size, gpuBytes: loaded?.size_vram,
    fullyGpuResident: Boolean(loaded?.size) && loaded.size_vram === loaded.size,
    passed: report.loaded.models?.length === 1 && loaded.name === model && loaded.context_length === 16384 };
  report.results.push(residency); if (!residency.passed) report.failures.push(residency.name);
  report.complete = report.failures.length === 0;
} catch (error) { report.failures.push(error.message); report.complete = false; console.error(error.message); }
finally { await writeFile(resolve(directory, 'api-benchmark.json'), JSON.stringify(report, null, 2) + '\n'); }
if (!report.complete) process.exitCode = 1;
