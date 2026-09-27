import http from 'node:http';
import { URL } from 'node:url';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { config, redactSecrets, requireGoogleCredentials, savePersistentConfig } from './config.js';
import { saveToken } from './auth-lib.js';

export async function runAuth(): Promise<void> {
  requireGoogleCredentials();
  await savePersistentConfig({ googleClientId: config.googleClientId, googleClientSecret: config.googleClientSecret });
  const port = Number.parseInt(process.env.OBSIDIAN_MCP_AUTH_PORT ?? '53682', 10);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomUUID();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive'],
    code_challenge_method: CodeChallengeMethod.S256, code_challenge: codeChallenge, state,
  });

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2callback') { res.writeHead(404).end('Not found'); return; }
        const error = url.searchParams.get('error');
        if (error) throw new Error(`Google authorization failed: ${error}`);
        if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch. Refusing callback.');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('No authorization code returned by Google.');
        const { tokens } = await client.getToken({ code, codeVerifier });
        await saveToken(tokens);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Authorization complete. You can close this browser tab.');
        console.error(`✓ OAuth token saved to ${config.tokenFile}`);
        server.close(() => resolve());
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Authorization failed. Check the terminal for details.');
        console.error(`OAuth failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.error(`OAuth callback listening on ${redirectUri}`);
      console.error('If this runs on a VPS, create an SSH tunnel from your PC first:');
      console.error(`  ssh -L ${port}:127.0.0.1:${port} root@YOUR_VPS_IP`);
      console.error('\nOpen this authorization URL in your browser:\n');
      console.error(authUrl);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuth().catch((error) => { console.error(redactSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
}
