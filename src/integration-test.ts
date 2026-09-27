import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createAuthedClient } from './auth-lib.js';
import { DriveBridge, FOLDER_MIME } from './drive.js';
import { replaceExact } from './note-ops.js';

if (process.env.OBSIDIAN_INTEGRATION_TEST !== '1') {
  console.error('Refusing to write to Drive. Set OBSIDIAN_INTEGRATION_TEST=1 to explicitly enable this round-trip test.');
  process.exitCode = 2;
} else {
  const auth = await createAuthedClient();
  const drive = new DriveBridge(auth);
  const unique = randomUUID();
  let currentPath = `Hermes MCP Integration Test ${unique}.md`;
  let currentVersion: string | undefined;
  let currentId: string | undefined;
  try {
    const vault = await drive.vault();
    const created = await drive.createNote(currentPath, `Integration test marker: ${unique}\n`);
    currentVersion = created.version;
    assert.ok(currentVersion, 'Drive returned a version for the created note');
    currentId = created.id;
    const read = await drive.fileByPath(currentPath);
    assert.ok(read && read.mimeType !== FOLDER_MIME, 'created note can be found');
    assert.equal(await drive.readContent(read), `Integration test marker: ${unique}\n`);

    const patched = replaceExact(await drive.readContent(read), unique, `${unique}-patched`);
    const afterPatch = await drive.writeNote(currentPath, patched.content, { expectedVersion: read.version });
    const patchRead = await drive.fileByPath(currentPath);
    assert.ok(patchRead);
    assert.match(await drive.readContent(patchRead), /-patched/);

    const staleVersion = currentVersion;
    const beforeAppend = await drive.fileByPath(currentPath);
    assert.ok(beforeAppend);
    const appended = await drive.writeNote(currentPath, `${await drive.readContent(beforeAppend)}append marker\n`, { expectedVersion: beforeAppend.version });
    assert.ok(appended.version);

    let conflictDetected = false;
    try { await drive.writeNote(currentPath, 'stale overwrite must not land', { expectedVersion: staleVersion }); }
    catch (error) { conflictDetected = error instanceof Error && error.message.startsWith('Conflict:'); }
    assert.equal(conflictDetected, true, 'stale expected version is rejected');

    const movedPath = `Hermes MCP Integration Tests/${currentPath}`;
    const moved = await drive.moveNote(currentPath, movedPath, { expectedVersion: appended.version });
    currentPath = movedPath;
    assert.equal(moved.id, currentId, 'move preserves Drive file identity');
    const movedRead = await drive.fileByPath(currentPath);
    assert.ok(movedRead);
    assert.match(await drive.readContent(movedRead), /append marker/);
    currentVersion = movedRead.version;
    assert.ok(currentVersion, 'Drive returned a version for the moved note');

    console.log(`✓ Drive round trip passed for vault ${vault.name}`);
    if (config.allowDelete) {
      await drive.deleteNote(currentPath, currentVersion);
      console.log('✓ Test note moved to Drive trash');
    } else {
      console.log(`Test note remains for manual cleanup: ${currentPath}`);
      console.log('Enable OBSIDIAN_ALLOW_DELETE=true and run delete_note, or trash it manually in Google Drive.');
    }
  } catch (error) {
    console.error(`Integration test failed: ${error instanceof Error ? error.message : String(error)}`);
    if (currentId) console.error(`Test object may need cleanup in Drive: ${currentPath} (ID ${currentId})`);
    process.exitCode = 1;
  }
}
