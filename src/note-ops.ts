export function replaceExact(text: string, oldText: string, newText: string, replaceAll = false): { content: string; replacements: number } {
  if (!oldText) throw new Error('old_text must not be empty.');
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) throw new Error('old_text was not found. Re-read the note and patch against current content.');
  if (occurrences > 1 && !replaceAll) throw new Error(`old_text occurs ${occurrences} times. Set replace_all=true or provide a more specific fragment.`);
  return { content: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText), replacements: replaceAll ? occurrences : 1 };
}

export function assertVersion(expected: string | undefined, actual: string | undefined, path: string): void {
  if (expected && expected !== actual) {
    throw new Error(`Conflict: ${path} changed since it was read. Expected Drive version ${expected}, current is ${actual ?? '(unknown)'}. Re-read before writing.`);
  }
}

export function assertDeleteEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('Deletion is disabled. Set OBSIDIAN_ALLOW_DELETE=true to enable delete_note.');
}
