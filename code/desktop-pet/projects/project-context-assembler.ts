import { ManagementError } from '../contracts/management.js';
import type {
  ProjectContextAssemblerPort, ProjectContextInput, ProjectContextResult, ProjectMemoryItem,
  ProjectMemoryPort, ProjectRecentTurn,
} from '../contracts/project-memory.js';
import { validateProjectProviderBudget } from '../app/project-context.js';
import { projectMemoryRelevanceScore, projectMemoryTerms } from './project-memory-relevance.js';

const RECALL_LIMIT = 100;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Count the complete structured material that a provider adapter would need to render. */
function used(input: ProjectContextInput, turns: readonly ProjectRecentTurn[],
  memories: readonly ProjectMemoryItem[]): number {
  return input.budget.fixedOverheadUtf8Bytes + bytes({ current: input.current, recentTurns: turns, memories });
}

function validate(input: ProjectContextInput): void {
  validateProjectProviderBudget(input.budget, input.task.providerInstanceId);
  if (input.task.origin !== 't3' || input.task.projectId !== input.projectId ||
      input.task.id !== input.taskId || input.recent.version !== '0.1.0' ||
      input.recent.projectId !== input.projectId || input.recent.taskId !== input.taskId ||
      input.recent.environmentId !== input.task.environmentId ||
      input.recent.threadId !== input.task.threadId ||
      input.recent.branchRef !== (input.branchRef ?? null)) {
    throw new ManagementError('version_conflict', '项目上下文来源身份已变化。');
  }
  if (!input.current.messageId || !input.current.text.trim()) {
    throw new ManagementError('invalid_request', '当前任务原文无效。');
  }
}

/** Pure selection: never sends a provider command or reads companion memory. */
export class ProjectContextAssembler implements ProjectContextAssemblerPort {
  constructor(private readonly memory: Pick<ProjectMemoryPort, 'recall'>) {}

  async assemble(input: ProjectContextInput): Promise<ProjectContextResult> {
    validate(input);
    const identity = { projectId: input.projectId, taskId: input.taskId,
      currentMessageId: input.current.messageId };
    const ceiling = input.budget.maxInputUtf8Bytes;
    if (used(input, [], []) > ceiling) return { status: 'over_budget', reason: 'current_input', ...identity };

    const source = input.recent.turns;
    const newest = source.at(-1);
    if (newest && used(input, [newest], []) > ceiling) {
      return { status: 'over_budget', reason: 'newest_complete_turn', ...identity };
    }

    const turns: ProjectRecentTurn[] = [];
    for (let index = source.length - 1; index >= 0; index--) {
      const trial = [source[index]!, ...turns];
      if (used(input, trial, []) > ceiling) break;
      turns.unshift(source[index]!);
    }

    const newestUserText = newest?.messages.filter(message => message.role === 'user')
      .map(message => message.text).join(' ') ?? '';
    const recalled = await this.memory.recall({ projectId: input.projectId,
      ...(input.recent.branchRef ? { branchRef: input.recent.branchRef } : {}),
      limit: RECALL_LIMIT, relevance: { currentText: input.current.text, newestUserText } });
    const applicable = recalled.filter(item => item.projectId === input.projectId &&
      item.status === 'accepted' && !item.supersededById &&
      (!item.branchRef || item.branchRef === input.recent.branchRef));
    const current = projectMemoryTerms(input.current.text);
    const recent = projectMemoryTerms(newestUserText);
    applicable.sort((a, b) => projectMemoryRelevanceScore(b.text, current, recent) -
      projectMemoryRelevanceScore(a.text, current, recent) ||
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const memories: ProjectMemoryItem[] = [];
    for (const item of applicable) {
      if (used(input, turns, [...memories, item]) <= ceiling) memories.push(item);
    }
    return { status: 'ready', ...identity, recentTurns: turns, memories,
      usedUtf8Bytes: used(input, turns, memories), hasOlderNativeHistory: input.recent.hasOlder,
      omittedOlderTurns: source.length - turns.length,
      omittedMemories: applicable.length - memories.length };
  }
}
