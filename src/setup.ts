import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config, normalizeTimezone, reloadConfig, savePersistentConfig } from './config.js';
import { runAuth } from './auth.js';
import { createAuthedClient } from './auth-lib.js';
import { DriveBridge } from './drive.js';

async function ask(prompt: string, fallback = ''): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(prompt)).trim();
    return answer || fallback;
  } finally { rl.close(); }
}

async function askSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    console.error('Secret input cannot be hidden in this terminal; input will be echoed.');
    return ask(prompt);
  }
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === 'c') || character === '\u0003') {
        finish(new Error('Setup cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter' || character === '\r' || character === '\n') {
        finish();
      } else if (key.name === 'backspace' || character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
      } else if (character) {
        value += character;
      }
    };
    stdin.on('keypress', onKeypress);
  });
}

async function main() {
  console.log('Hermes Obsidian Drive MCP Setup\n');
  const clientId = await ask('Google OAuth Client ID: ', config.googleClientId);
  const clientSecret = await askSecret('Google OAuth Client Secret: ');
  const timezone = normalizeTimezone(await ask(`Timezone (IANA or UTC offset, e.g. +4) [${config.timezone}]: `, config.timezone));
  const autoUpdateAnswer = (await ask(`Automatically install stable GitHub releases at startup? [${config.autoUpdate ? 'Y/n' : 'y/N'}]: `, config.autoUpdate ? 'y' : 'n')).toLowerCase();
  const autoUpdate = ['y', 'yes', 'true', '1'].includes(autoUpdateAnswer);
  if (!/^[+-]\d{2}:\d{2}$/.test(timezone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw new Error(`Invalid IANA timezone or UTC offset: ${timezone}`); }
  }
  if (!clientId || !clientSecret) throw new Error('Client ID and client secret are required.');

  await savePersistentConfig({ googleClientId: clientId, googleClientSecret: clientSecret, timezone, autoUpdate }, config.configFile);
  reloadConfig();
  console.log('\nOpening Google authorization...');
  await runAuth();

  const bridge = new DriveBridge(await createAuthedClient());
  const vaults = await bridge.discoverVaults();
  if (!vaults.length) throw new Error('Authorization succeeded, but no Richard-synced vaults were found in this account.');
  console.log('\nFound Richard-synced vaults:');
  vaults.forEach((vault, index) => console.log(`${index + 1}. ${vault.name}`));
  let selected = vaults[0];
  if (vaults.length > 1) {
    const choice = Number(await ask('Choose vault number: '));
    if (!Number.isInteger(choice) || choice < 1 || choice > vaults.length) throw new Error('Invalid vault selection. Run npm run setup again.');
    selected = vaults[choice - 1]!;
  }
  await savePersistentConfig({ vaultName: selected.name }, config.configFile);
  reloadConfig();
  console.log(`\n✓ Selected “${selected.name}”`);
  console.log(`✓ Configuration saved to ${config.configFile}`);
  console.log(`✓ GitHub release auto-update: ${autoUpdate ? 'enabled' : 'disabled'}`);
  console.log('\nSetup complete. Next run: npm run doctor');
}

main().catch((error) => { console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
