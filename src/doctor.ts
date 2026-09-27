import fs from 'node:fs/promises';
import { config } from './config.js';
import { createAuthedClient } from './auth-lib.js';
import { DriveBridge, FOLDER_MIME } from './drive.js';
import { unSplitPath } from './path.js';

async function main() {
  let ready = true;
  const check = (ok: boolean, message: string) => {
    console.log(`${ok ? '✓' : '✗'} ${message}`);
    if (!ok) ready = false;
  };
  console.log('Hermes Obsidian Drive MCP — Doctor\n');

  const configExists = await fs.access(config.configFile).then(() => true, () => false);
  check(configExists, configExists ? `Configuration loaded (${config.configFile})` : `Configuration file missing (${config.configFile}); run npm run setup`);
  const credentialsExist = !!config.googleClientId && !!config.googleClientSecret;
  check(credentialsExist, credentialsExist ? 'Google OAuth credentials configured' : 'Google OAuth credentials missing; run npm run setup');
  const tokenExists = await fs.access(config.tokenFile).then(() => true, () => false);
  check(tokenExists, tokenExists ? `OAuth token exists (${config.tokenFile})` : `OAuth token missing (${config.tokenFile})`);
  console.log(`✓ Timezone: ${config.timezone}`);
  console.log(`✓ Deletes ${config.allowDelete ? 'enabled' : 'disabled'}`);

  if (!configExists || !credentialsExist || !tokenExists) {
    check(false, 'MCP is not ready; complete setup and rerun doctor');
    console.log('\nNo writes were performed.');
    process.exitCode = 1;
    return;
  }

  const auth = await createAuthedClient({ persistRefreshedTokens: false });
  const { token } = await auth.getAccessToken();
  check(!!token, 'OAuth token refresh works');
  if (!token) throw new Error('No access token returned.');

  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Google Drive API check failed (${response.status} ${response.statusText}).`);
  const about = await response.json() as { user?: { displayName?: string; emailAddress?: string } };
  check(true, 'Google Drive API reachable');
  console.log(`✓ Signed in as ${about.user?.displayName ?? '(unknown)'} <${about.user?.emailAddress ?? 'unknown'}>`);

  const bridge = new DriveBridge(auth);
  const vaults = await bridge.discoverVaults();
  check(vaults.length > 0, `Richard-compatible vault discovery (${vaults.length} found)`);
  if (config.vaultName) {
    const selected = vaults.find((vault) => vault.name === config.vaultName);
    check(!!selected, `Selected vault exists: ${config.vaultName}`);
  } else if (vaults.length === 1) {
    console.log(`✓ Single vault auto-selected: ${vaults[0]!.name}`);
  } else {
    check(false, vaults.length ? `Multiple vaults found; run npm run setup to choose one: ${vaults.map(v => v.name).join(', ')}` : 'No compatible vault found');
  }

  if (config.vaultName || vaults.length === 1) {
    const files = await bridge.allVaultFiles({ notesOnly: true });
    const notes = files.filter(file => file.mimeType !== FOLDER_MIME && unSplitPath(file.properties).toLowerCase().endsWith('.md'));
    const paths = notes.map(file => unSplitPath(file.properties));
    const duplicates = paths.filter((value, index) => paths.indexOf(value) !== index);
    const malformed = notes.filter(file => {
      const properties = file.properties ?? {};
      const keys = Object.keys(properties).filter(key => /^path\d*$/.test(key));
      const indices = keys.map(key => key === 'path' ? 1 : Number(key.slice(4))).sort((a, b) => a - b);
      return !indices.length || indices.some((value, index) => value !== index + 1) || !unSplitPath(properties);
    });
    check(duplicates.length === 0, `No duplicate note paths${duplicates.length ? ` (${duplicates.slice(0, 5).join(', ')})` : ''}`);
    check(malformed.length === 0, `No malformed Richard path metadata (${malformed.length})`);
    check(true, `${notes.length} Richard-compatible Markdown notes discovered`);
  }

  check(ready, ready ? 'MCP ready' : 'MCP is not ready; fix the failed checks above');
  console.log('\nNo writes were performed.');
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`✗ Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\nNo writes were performed.');
  process.exitCode = 1;
});
