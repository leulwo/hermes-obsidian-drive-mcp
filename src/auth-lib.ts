import fs from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { config, requireGoogleCredentials } from './config.js';

export async function loadToken(): Promise<Credentials> {
  const raw = await fs.readFile(config.tokenFile, 'utf8').catch(() => '');
  if (!raw) {
    throw new Error(`Google token not found at ${config.tokenFile}. Run: npm run auth`);
  }
  return JSON.parse(raw) as Credentials;
}

export async function saveToken(token: Credentials): Promise<void> {
  await fs.mkdir(path.dirname(config.tokenFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(config.tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  await fs.chmod(config.tokenFile, 0o600);
}

export async function createAuthedClient(options: { persistRefreshedTokens?: boolean } = {}): Promise<OAuth2Client> {
  requireGoogleCredentials();
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret);
  client.setCredentials(await loadToken());
  if (options.persistRefreshedTokens !== false) client.on('tokens', async (tokens) => {
    const existing = await loadToken().catch(() => ({}));
    await saveToken({ ...existing, ...tokens });
  });
  return client;
}
