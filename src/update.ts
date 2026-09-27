import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';

export const UPDATE_REPOSITORY = 'leulwo/hermes-obsidian-drive-mcp';
const EXPECTED_ORIGIN = `https://github.com/${UPDATE_REPOSITORY}.git`;

export interface SemVer { major: number; minor: number; patch: number }

export function parseSemVer(value: string): SemVer | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) throw new Error(`Invalid stable Semantic Version: ${!a ? left : right}`);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function projectRoot(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(current, '../..'), path.resolve(current, '..')];
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!root) throw new Error('Could not locate the MCP project package.json.');
  return root;
}

function currentVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
  if (!pkg.version || !parseSemVer(pkg.version)) throw new Error('Local package.json does not contain a stable SemVer version.');
  return pkg.version;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'npm.cmd',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  return result.stdout.trim();
}

async function latestRelease(): Promise<{ tag: string; version: string } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hermes-obsidian-drive-mcp' },
      signal: controller.signal,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}.`);
    const release = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean };
    if (release.draft || release.prerelease || !release.tag_name) return undefined;
    const version = release.tag_name.replace(/^v/, '');
    if (!parseSemVer(version)) throw new Error(`Latest GitHub release has an invalid version tag: ${release.tag_name}`);
    return { tag: release.tag_name, version };
  } finally {
    clearTimeout(timeout);
  }
}

function assertTrustedCleanClone(root: string): void {
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], root);
  if (inside !== 'true') throw new Error('Auto-update requires a Git clone of the project. Reinstall from the GitHub repository first.');
  const origin = run('git', ['remote', 'get-url', 'origin'], root).replace(/\.git$/, '').replace(/\/$/, '');
  const accepted = [EXPECTED_ORIGIN.replace(/\.git$/, ''), `git@github.com:${UPDATE_REPOSITORY}`];
  if (!accepted.includes(origin)) throw new Error('Auto-update refused: Git origin is not the configured official GitHub repository.');
  if (run('git', ['status', '--porcelain'], root)) throw new Error('Auto-update refused because the project has local changes. Commit or stash them first.');
}

async function checkAndMaybeApply(apply: boolean): Promise<void> {
  const root = projectRoot();
  const current = currentVersion(root);
  const latest = await latestRelease();
  if (!latest) {
    console.error('No stable GitHub release is published yet.');
    return;
  }
  const comparison = compareSemVer(latest.version, current);
  if (comparison <= 0) {
    console.error(`✓ MCP is current (${current}; latest release ${latest.version}).`);
    return;
  }
  console.error(`Update available: ${current} → ${latest.version}.`);
  if (!apply) return;

  assertTrustedCleanClone(root);
  const previous = run('git', ['rev-parse', 'HEAD'], root);
  try {
    run('git', ['fetch', '--tags', 'origin'], root);
    run('git', ['checkout', '--detach', latest.tag], root);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], root);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], root);
    console.error(`✓ Updated project files to ${latest.version}. This MCP process will use the update on its next launch.`);
  } catch (error) {
    console.error(`Update failed; attempting to restore the previous release: ${error instanceof Error ? error.message : String(error)}`);
    try {
      run('git', ['checkout', '--detach', previous], root);
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], root);
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], root);
      console.error('Previous release restored.');
    } catch (rollbackError) {
      console.error(`Rollback also failed. The project needs manual recovery: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
  }
}

export async function runStartupUpdateCheck(): Promise<void> {
  if (!config.autoUpdate) return;
  try {
    await checkAndMaybeApply(true);
  } catch (error) {
    console.error(`Auto-update skipped; continuing with the installed version: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== '--check' && mode !== '--apply') {
    console.error('Usage: npm run update:check | npm run update');
    process.exitCode = 2;
  } else {
    checkAndMaybeApply(mode === '--apply').catch((error) => {
      console.error(`Update command failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
