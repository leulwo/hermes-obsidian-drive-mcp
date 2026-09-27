import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PersistentConfig {
  googleClientId?: string;
  googleClientSecret?: string;
  vaultName?: string;
  timezone?: string;
  allowDelete?: boolean;
  autoUpdate?: boolean;
}

export interface RuntimeConfig extends Required<Omit<PersistentConfig, 'vaultName' | 'googleClientId' | 'googleClientSecret'>> {
  googleClientId: string;
  googleClientSecret: string;
  tokenFile: string;
  configFile: string;
  vaultName?: string;
  maxNoteBytes: number;
  searchConcurrency: number;
  searchMaxFiles: number;
}

const DEFAULT_TIMEZONE = 'UTC';
const APP_DIRECTORY = 'hermes-obsidian-drive-mcp';

export function normalizeTimezone(input: string): string {
  const value = input.trim();
  const offset = /^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(value);
  if (!offset) return value;
  const hours = Number(offset[2]);
  const minutes = Number(offset[3] ?? '0');
  if ((offset[1] === '+' && hours > 14) || (offset[1] === '-' && (hours > 12 || (hours === 12 && minutes !== 0))) || minutes > 59 || (hours === 14 && minutes !== 0)) {
    throw new Error(`Invalid UTC offset ${JSON.stringify(input)}. Use a value from -12 to +14, optionally with minutes (for example +4 or +05:30).`);
  }
  const sign = offset[1] === '-' && (hours !== 0 || minutes !== 0) ? '-' : '+';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function defaultConfigDirectory(env: NodeJS.ProcessEnv): string {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, APP_DIRECTORY);
  const legacyPath = path.join(os.homedir(), '.config', APP_DIRECTORY);
  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(legacyPath, 'config.json')) || fs.existsSync(path.join(legacyPath, 'token.json'))) return legacyPath;
    if (env.APPDATA) return path.join(env.APPDATA, APP_DIRECTORY);
  }
  return legacyPath;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function configPaths(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.OBSIDIAN_MCP_CONFIG_DIR || defaultConfigDirectory(env);
  return {
    directory,
    configFile: env.OBSIDIAN_MCP_CONFIG_FILE || path.join(directory, 'config.json'),
    tokenFile: env.OBSIDIAN_MCP_TOKEN_FILE || path.join(directory, 'token.json'),
  };
}

export function readPersistentConfig(file = configPaths().configFile): PersistentConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PersistentConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read MCP configuration at ${file}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env, persisted = readPersistentConfig(configPaths(env).configFile)): RuntimeConfig {
  const paths = configPaths(env);
  const timezone = normalizeTimezone(env.OBSIDIAN_TIMEZONE || persisted.timezone || DEFAULT_TIMEZONE);
  if (!/^[+-]\d{2}:\d{2}$/.test(timezone)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new Error(`Invalid IANA timezone ${JSON.stringify(timezone)}. Set OBSIDIAN_TIMEZONE or update config.json.`);
    }
  }
  return {
    googleClientId: env.GOOGLE_CLIENT_ID || persisted.googleClientId || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || persisted.googleClientSecret || '',
    tokenFile: paths.tokenFile,
    configFile: paths.configFile,
    vaultName: env.OBSIDIAN_VAULT_NAME?.trim() || persisted.vaultName?.trim() || undefined,
    timezone,
    allowDelete: envBool(env.OBSIDIAN_ALLOW_DELETE, persisted.allowDelete ?? true),
    autoUpdate: envBool(env.OBSIDIAN_MCP_AUTO_UPDATE, persisted.autoUpdate ?? false),
    maxNoteBytes: envInt(env.OBSIDIAN_MAX_NOTE_BYTES, 4 * 1024 * 1024),
    searchConcurrency: envInt(env.OBSIDIAN_SEARCH_CONCURRENCY, 8),
    searchMaxFiles: envInt(env.OBSIDIAN_SEARCH_MAX_FILES, 5000),
  };
}

export async function savePersistentConfig(values: PersistentConfig, file = configPaths().configFile): Promise<void> {
  const directory = path.dirname(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.promises.chmod(directory, 0o700);
  let current: PersistentConfig = {};
  try { current = JSON.parse(await fs.promises.readFile(file, 'utf8')) as PersistentConfig; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.promises.writeFile(file, `${JSON.stringify({ ...current, ...values }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.promises.chmod(file, 0o600);
}

export let config = resolveConfig();

export function reloadConfig(): RuntimeConfig {
  config = resolveConfig();
  return config;
}

export function requireGoogleCredentials(): void {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error(`Google OAuth credentials are not configured. Run “npm run setup” or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Configuration file: ${config.configFile}`);
  }
}

export function redactSecrets(message: string, extra: string[] = []): string {
  return [config.googleClientId, config.googleClientSecret, ...extra].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), message);
}
