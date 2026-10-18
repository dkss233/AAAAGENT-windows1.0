import type { DialogueRequest } from '../contracts/index.js';
import type { EmotionAssessment, EmotionObservation } from '../contracts/emotion-state.js';

export const EMOTION_RESPONSE_RULES = `同时返回emotionAssessment:{"user":null,"companion":null}。两个值各自可为null（本轮无新依据，保持原背景），或{label:简短情绪词,intensity:数值或null,confidence:数值或null}。user的label使用neutral/happy/sad/angry/fear/disgust/surprise/unknown；user结合本轮用户文字、最近连续对话和实际感知推测用户此刻的情绪；companion独立描述助手自己的持续心情，可为关心或平静，不要复制用户难过。expression只是本轮表现，不能代替这两个判断。intensity是情绪强弱、confidence是你对判断的把握，都用0到1之间的小数（如0.3、0.7）；本轮有依据时给出估计值，只有完全无法判断时才填null。按本轮语气、用词强度和话题轻重估强度，按线索是否明确成把握估置信度。不要把情绪类别机械换算成固定数值（不是见到sad就填0.8），也不要在有明确线索时一律填null。“嗯”“然后呢”等无新线索允许null；用户明确否认旧判断且无法确认新情绪时label用unknown、两数值null。第三人称“朋友今天很难过”、过去时“以前很难过，现在好多了”、假设“如果没通过我会很难过”不能直接标为用户现在难过。近期用户纠正优先，背景只是历史线索。`;
/** How the recorded mood is meant to reach the reply itself.
 *
 *  EMOTION_RESPONSE_RULES only says how to FILL IN emotionAssessment. Without this second half the
 *  background was a field the model could read but had no instruction to act on, so the pet could
 *  report "关心" and then answer in a completely unrelated tone. Kept separate because it is about the
 *  reply rather than the assessment, and because the background is absent until the first observation
 *  exists — nothing here is sent if there is no mood to carry.
 *
 *  The last sentence exists to stop the two mechanisms blurring: expression is this turn's face,
 *  the background is what the pet is actually carrying, and only the latter should hold across turns. */
export const EMOTION_BACKGROUND_RULES = `emotionBackground是你和用户此刻的持续心情，不是本轮表情；companion是你自己的心情，语气应与它一致并自然延续，不要每轮重新设定，也不要因为换了话题就丢掉。emotionBackground.user供你理解用户此刻的状态，回应时照顾它，但不要直接复述或宣称你检测到了心情。expression只决定本轮脸上的表现，不能代替emotionBackground。`;
export function normalizeUserEmotion(value:string):string|null {
  const aliases:Record<string,string>={neutral:'neutral',平静:'neutral',中性:'neutral',happy:'happy',开心:'happy',高兴:'happy',快乐:'happy',sad:'sad',难过:'sad',伤心:'sad',悲伤:'sad',angry:'angry',生气:'angry',愤怒:'angry',fear:'fear',fearful:'fear',害怕:'fear',disgust:'disgust',disgusted:'disgust',厌恶:'disgust',surprise:'surprise',surprised:'surprise',惊讶:'surprise',unknown:'unknown',未知:'unknown',未确定:'unknown'};
  return aliases[value.trim().toLowerCase()]??null;
}
const score = (v: unknown): v is number | null => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
/** Optional metadata fails independently; never discards an otherwise usable spoken reply.
 *
 *  `current` is supplied by the caller because the assembled context deliberately EXCLUDES the turn being
 *  answered: memory/context.ts drops it (`if(turn[0]?.id===currentId)continue`) since the question is
 *  already carried by the provider's currentMessage. Searching `recent` for it therefore found nothing,
 *  the model's correct assessment was thrown away by this guard, and the console showed 暂无 for every
 *  subject. A caller that does have the message in `recent` may omit the argument. */
export function parseEmotionAssessment(raw: unknown, request: DialogueRequest,
  current?: {id:string;version:number}): EmotionAssessment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string,unknown>;
  const inContext = request.context.recent.find(m => m.id === `${request.scope.turnId}:user`);
  // The supplied identity must belong to THIS turn. Without this check it would be self-confirming: the
  // message is built from request.text, so comparing the two back would always agree and any caller
  // could bind an assessment to an unrelated message.
  if (current && current.id !== `${request.scope.turnId}:user`) return undefined;
  const message = inContext ?? (current ? {characterId: request.scope.characterId, id: current.id,
    role: 'user' as const, text: request.text, createdAt: new Date().toISOString()} : undefined);
  if (!message || message.role !== 'user' || message.text !== request.text) return undefined;
  const source = current ?? inContext?.emotionSnapshot?.message ?? {id: message.id, version: 1};
  const parse = (subject:'user'|'companion'): EmotionObservation | null => {
    const v=value[subject];
    if (v === null) return null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_emotion');
    const item = v as Record<string,unknown>;
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length>80 || /[\u0000-\u001f]/.test(item.label)
      || !score(item.intensity) || !score(item.confidence)) throw Error('invalid_emotion');
    const label=subject==='user'?normalizeUserEmotion(item.label):item.label.trim();if(!label)throw Error('invalid_emotion');
    return {subject,label,intensity:item.intensity,confidence:item.confidence,
      provenance:subject==='user'?'text_recent_context':'companion_inference',sources:[source]};
  };
  try { return {user:parse('user'),companion:parse('companion')}; } catch { return undefined; }
}
