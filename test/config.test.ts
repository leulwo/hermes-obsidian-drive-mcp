import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { configPaths, normalizeTimezone, readPersistentConfig, redactSecrets, resolveConfig, savePersistentConfig } from '../src/config.js';
import { isVaultFile, selectVault, type DriveFile } from '../src/drive.js';
import { assertDeleteEnabled, assertVersion, replaceExact } from '../src/note-ops.js';
import { basename, dirname } from '../src/path.js';
import { formatInTimezone, timeContext } from '../src/time.js';
import { compareSemVer, parseSemVer } from '../src/update.js';

test('explicit environment overrides persisted configuration and defaults', () => {
  const resolved = resolveConfig({ GOOGLE_CLIENT_ID: 'env-id', OBSIDIAN_TIMEZONE: 'UTC', OBSIDIAN_ALLOW_DELETE: 'false' }, {
    googleClientId: 'saved-id', googleClientSecret: 'saved-secret', vaultName: 'Saved Vault', timezone: 'Europe/Paris', allowDelete: true,
  });
  assert.equal(resolved.googleClientId, 'env-id');
  assert.equal(resolved.googleClientSecret, 'saved-secret');
  assert.equal(resolved.vaultName, 'Saved Vault');
  assert.equal(resolved.timezone, 'UTC');
  assert.equal(resolved.allowDelete, false);
  assert.equal(resolved.autoUpdate, false);
  assert.equal(resolveConfig({ OBSIDIAN_MCP_AUTO_UPDATE: 'true' }, { autoUpdate: false }).autoUpdate, true);
  assert.equal(resolveConfig({}, { autoUpdate: true }).autoUpdate, true);
  assert.equal(resolveConfig({}, {}).timezone, 'UTC');
  assert.equal(resolveConfig({}, {}).allowDelete, true);
  assert.equal(resolveConfig({}, { allowDelete: false }).allowDelete, false);
  assert.equal(resolveConfig({ OBSIDIAN_ALLOW_DELETE: 'false' }, {}).allowDelete, false);
});

test('release versions use stable SemVer ordering', () => {
  assert.deepEqual(parseSemVer('v1.2.0'), { major: 1, minor: 2, patch: 0 });
  assert.equal(compareSemVer('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemVer('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemVer('1.2.0', '1.2.0'), 0);
  assert.equal(parseSemVer('1.2'), undefined);
});

test('invalid timezone fails configuration loading', () => {
  assert.throws(() => resolveConfig({}, { timezone: 'Mars/Olympus' }), /Invalid IANA timezone/);
});

test('setup-style UTC offsets normalize and remain fixed-offset timezones', () => {
  assert.equal(normalizeTimezone('+4'), '+04:00');
  assert.equal(normalizeTimezone('-5:30'), '-05:30');
  assert.equal(resolveConfig({}, { timezone: '+4' }).timezone, '+04:00');
  assert.throws(() => normalizeTimezone('+15'), /Invalid UTC offset/);
  assert.throws(() => normalizeTimezone('-13'), /Invalid UTC offset/);
  assert.throws(() => normalizeTimezone('-12:30'), /Invalid UTC offset/);
});

test('multiple vault selection requires explicit choice and one vault auto-selects', () => {
  const vaults = [{ name: 'A', rootId: 'a' }, { name: 'B', rootId: 'b' }];
  assert.throws(() => selectVault(vaults), /Multiple synced vaults/);
  assert.equal(selectVault(vaults, 'B').rootId, 'b');
  assert.equal(selectVault([vaults[0]!]).name, 'A');
});

test('vault filtering excludes other vaults, roots, and config files by default', () => {
  const item = (properties: Record<string, string>): DriveFile => ({ id: 'id', name: 'n', mimeType: 'text/markdown', properties });
  assert.equal(isVaultFile(item({ vault: 'A', path: 'n.md' }), 'A'), true);
  assert.equal(isVaultFile(item({ vault: 'B', path: 'n.md' }), 'A'), false);
  assert.equal(isVaultFile(item({ vault: 'A', obsidian: 'vault' }), 'A'), false);
  assert.equal(isVaultFile(item({ vault: 'A', config: 'true' }), 'A'), false);
  assert.equal(isVaultFile(item({ vault: 'A', config: 'true' }), 'A', true), true);
});

test('persisted config and token paths are configurable and credentials load without environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-config-'));
  try {
    const file = path.join(dir, 'config.json');
    await savePersistentConfig({ googleClientId: 'saved.apps.googleusercontent.com', googleClientSecret: 'saved-secret', vaultName: 'Vault' }, file);
    const env = { OBSIDIAN_MCP_CONFIG_FILE: file, OBSIDIAN_MCP_CONFIG_DIR: dir };
    const loaded = readPersistentConfig(file);
    const resolved = resolveConfig(env, loaded);
    assert.equal(resolved.googleClientId, 'saved.apps.googleusercontent.com');
    assert.equal(resolved.googleClientSecret, 'saved-secret');
    assert.equal(resolved.vaultName, 'Vault');
    assert.equal(configPaths(env).tokenFile, path.join(dir, 'token.json'));
    assert.equal(configPaths({ XDG_CONFIG_HOME: dir }).directory, path.join(dir, 'hermes-obsidian-drive-mcp'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('MCP process starts with persisted credentials and no GOOGLE credential environment variables', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-startup-'));
  const configFile = path.join(dir, 'config.json');
  const tokenFile = path.join(dir, 'token.json');
  await savePersistentConfig({ googleClientId: 'persisted-client-id', googleClientSecret: 'persisted-client-secret', vaultName: 'Vault' }, configFile);
  await fs.writeFile(tokenFile, JSON.stringify({ refresh_token: 'test-refresh-token' }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, OBSIDIAN_MCP_CONFIG_FILE: configFile, OBSIDIAN_MCP_TOKEN_FILE: tokenFile };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  delete env.OBSIDIAN_MCP_AUTO_UPDATE;
  try {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/src/launcher.js')], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        if (child.exitCode === null) { child.kill(); resolve(); }
        else reject(new Error(`MCP exited during startup. output=${output}`));
      }, 2500);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`MCP exited during startup (${code}). output=${output}`)); });
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('MCP does not register a Drive-side create-note tool', async () => {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /registerTool\(['"]create_note['"]/);
});

test('exact patch fails on zero or ambiguous matches and replaces one match', () => {
  assert.throws(() => replaceExact('alpha', 'missing', 'x'), /not found/);
  assert.deepEqual(replaceExact('alpha beta', 'beta', 'gamma'), { content: 'alpha gamma', replacements: 1 });
  assert.throws(() => replaceExact('x x', 'x', 'y'), /occurs 2 times/);
  assert.deepEqual(replaceExact('x x', 'x', 'y', true), { content: 'y y', replacements: 2 });
});

test('stale versions are rejected and delete can be explicitly disabled', () => {
  assert.throws(() => assertVersion('42', '43', 'Note.md'), /Conflict: Note.md/);
  assert.doesNotThrow(() => assertVersion('42', '42', 'Note.md'));
  assert.throws(() => assertDeleteEnabled(false), /Deletion is disabled/);
  assert.doesNotThrow(() => assertDeleteEnabled(true));
});

test('secret redaction removes client and access tokens from errors', () => {
  const message = redactSecrets('client=client-secret token=access-token', ['client-secret', 'access-token']);
  assert.equal(message, 'client=[REDACTED] token=[REDACTED]');
});

test('timestamps format in the configured IANA timezone', () => {
  const date = new Date('2026-01-02T00:30:00.000Z');
  assert.equal(timeContext('Africa/Addis_Ababa', date).local_date, '2026-01-02');
  assert.match(formatInTimezone(date.toISOString(), 'Africa/Addis_Ababa') ?? '', /03:30:00/);
  assert.equal(timeContext('+04:00', date).local_time, '04:30:00');
  assert.equal(formatInTimezone(date.toISOString(), '+04:00'), '2026-01-02 04:30:00 UTC+04:00');
});

test('nested path helpers preserve parent and leaf components', () => {
  assert.equal(dirname('School/Physics/notes.md'), 'School/Physics');
  assert.equal(basename('School/Physics/notes.md'), 'notes.md');
});
