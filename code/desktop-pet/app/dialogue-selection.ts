import type { TrialConfiguration } from './trial-config.js';
import { JsonDialogueProvider } from '../providers/qwen-dialogue.js';
import { LocalDialogueProvider, localDialogueBudget } from '../providers/local-dialogue.js';
import { inputBudgetInfo } from '../providers/input-count.js';
import type { EndpointConfig, ProviderTransport } from '../providers/transport.js';

/** Lazy cloud binding ensures a local selection never reads or captures the cloud dialogue key. */
export function selectTrialDialogue(configuration: Pick<TrialConfiguration, 'localDialogue' | 'models'>,
  cloudEndpoint: () => EndpointConfig, cloudTransport: ProviderTransport,
  visualPolicy: () => { presets: readonly { id: string; label: string }[] }, targetInputTokens: number | undefined,
  temperature?: number, localFetch: typeof fetch = fetch) {
  if (configuration.localDialogue) return {
    dialogue: new LocalDialogueProvider(configuration.localDialogue, visualPolicy, localFetch),
    foregroundBudget: localDialogueBudget(configuration.localDialogue, targetInputTokens),
  };
  return {
    dialogue: new JsonDialogueProvider(cloudEndpoint(), cloudTransport, visualPolicy, undefined,
      { outputTokenLimit: configuration.models.dialogue.outputTokenLimit, ...(temperature === undefined ? {} : { temperature }) }),
    foregroundBudget: inputBudgetInfo(configuration.models.dialogue, targetInputTokens),
  };
}
