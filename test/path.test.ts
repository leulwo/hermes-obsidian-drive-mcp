import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVaultPath, splitPath, unSplitPath } from '../src/path.js';

test('splitPath matches 100-byte chunks and round trips unicode', () => {
  const input = `Folder/${'ሀ'.repeat(80)}/note.md`;
  const props = splitPath(input);
  for (const value of Object.values(props)) {
    assert.ok(new TextEncoder().encode(value).length <= 100);
  }
  assert.equal(unSplitPath(props), input);
});

test('normalizeVaultPath rejects traversal', () => {
  assert.throws(() => normalizeVaultPath('../secret.md'));
  assert.equal(normalizeVaultPath('School\\Physics\\note', { requireMarkdown: true }), 'School/Physics/note.md');
});

test('splitPath keeps exactly 100 UTF-8 bytes together and starts a new chunk past the boundary', () => {
  const exactly = 'a'.repeat(100);
  assert.deepEqual(splitPath(exactly), { path: exactly });
  const justOver = `${exactly}b`;
  assert.deepEqual(splitPath(justOver), { path: exactly, path2: 'b' });
  const unicodeBoundary = `${'a'.repeat(99)}ሀx`;
  const properties = splitPath(unicodeBoundary);
  assert.deepEqual(Object.values(properties), ['a'.repeat(99), 'ሀx']);
  assert.equal(unSplitPath(properties), unicodeBoundary);
  assert.ok(Object.values(properties).every(chunk => new TextEncoder().encode(chunk).byteLength <= 100));
});
