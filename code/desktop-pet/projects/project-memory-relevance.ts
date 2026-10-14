/** Deterministic lexical ranking shared by storage and context assembly. */
export function projectMemoryTerms(value: string): ReadonlySet<string> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu)) {
    const word = match[0]!;
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      if (word.length === 1) result.add(word);
      else for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2));
    } else if (word.length > 1) result.add(word);
  }
  return result;
}

export function projectMemoryRelevanceScore(text: string, current: ReadonlySet<string>,
  newest: ReadonlySet<string>): number {
  let score = 0;
  for (const term of projectMemoryTerms(text)) score += current.has(term) ? 3 : newest.has(term) ? 1 : 0;
  return score;
}
