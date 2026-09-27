import { createAuthedClient } from './auth-lib.js';
import { DriveBridge, FOLDER_MIME } from './drive.js';
import { unSplitPath } from './path.js';

if (process.env.OBSIDIAN_INTEGRATION_TEST !== '1') {
  console.error('Set OBSIDIAN_INTEGRATION_TEST=1 to explicitly allow this live, read-only Drive check.');
  process.exitCode = 2;
} else {
  try {
    const auth = await createAuthedClient();
    const drive = new DriveBridge(auth);
    const vault = await drive.vault();
    const notes = (await drive.allVaultFiles({ notesOnly: true }))
      .filter((file) => file.mimeType !== FOLDER_MIME && unSplitPath(file.properties).toLowerCase().endsWith('.md'));
    if (notes[0]) await drive.readContent(notes[0]);
    console.log(`✓ Read-only Drive check passed for vault ${vault.name}; ${notes.length} Markdown notes discovered.`);
    console.log('No files were created, modified, moved, or deleted.');
  } catch (error) {
    console.error(`Integration check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
