import { EMOTION_RESPONSE_RULES } from '../../providers/emotion-inference.js';
import { DIALOGUE_RESPONSE_RULES } from '../../companion/dialogue-rules.js';

/** Adapt synthetic historical fixtures to current product admission. Does not edit raw text,
 * request strings, hashes, source IDs, versions, sessions or saved fixture modules.
 * This is a current-product regression, not a replay of the original product identity. */
export function companionFixture<T>(value:T):T {
  return JSON.parse(JSON.stringify(value), (key, item) => key==='characterId' && item==='friend' ? 'companion' : item) as T;
}

/** B51 emotion protocol is independently checked in emotion-inference.test;
 * Presentation/manual-edit rules and B-COMPANION-FEEDBACK-01's exact shared policy
 * postdate the frozen factor experiments. Compare the old prefix separately from
 * these identified additions, without regenerating raw fixtures or reclassifying
 * their semantic failures. spoken-text.test independently checks policy composition. */
export function historicalDialoguePrefix(current:string):string {
  const lines=current.replace(`\n${DIALOGUE_RESPONSE_RULES}`, '').replace(`\n${EMOTION_RESPONSE_RULES}`, '').split('\n');
  return lines.filter(line=>!line.startsWith('expression描述助手本轮回复的表达') && !line.startsWith('origin为manual的资料由用户在管理页人工编辑')).join('\n');
}

/** Removes the one schema addition this product intentionally made inside the frozen prefix.
 *
 *  The recorded prompts predate emotionAssessment being named in the JSON template. Naming it is the fix
 *  for the mood panel never filling: the model follows the literal template and omits any key the
 *  template does not show, so describing the field in EMOTION_RESPONSE_RULES alone was not enough. The
 *  addition therefore lands inside the prefix the factor tests protect — but nothing else there may
 *  move, so only this field is stripped and every remaining byte is still compared.
 *
 *  A forget reply carries no assessment, so stripping is then a no-op. */
export function withoutEmotionShape(value:string):string {
  const at=value.indexOf(',"emotionAssessment":');
  if (at<0) return value;
  let depth=0;
  for (let i=value.indexOf('{',at); i<value.length; i++) {
    if (value[i]==='{') depth++;
    else if (value[i]==='}' && --depth===0) return value.slice(0,at)+value.slice(i+1);
  }
  throw new Error('unterminated emotionAssessment shape in prompt');
}
