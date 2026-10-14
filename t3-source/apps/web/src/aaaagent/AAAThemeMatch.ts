// Compare the complete stored definition. Unknown fields and user edits prevent migration.
export function sameThemeDefinition(stored: unknown, generated: unknown): boolean {
  if (Object.is(stored, generated)) return true;
  if (!stored || !generated || typeof stored !== "object" || typeof generated !== "object" ||
      Array.isArray(stored) || Array.isArray(generated)) return false;
  const actual = stored as Record<string, unknown>, expected = generated as Record<string, unknown>;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every(key =>
    Object.hasOwn(expected, key) && sameThemeDefinition(actual[key], expected[key]));
}
