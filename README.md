# Hermes Obsidian Drive MCP

Connect Hermes Agent directly to the Google Drive vault synced by Richard Xiong's Obsidian Google Drive Sync plugin. This project includes both:

- a focused MCP connector for reading and safely editing Markdown notes; and
- a Hermes skill that teaches the agent how to use those tools safely.

It does not require Obsidian on the server, rclone, a second vault copy, or changes to Richard's plugin.

```text
Obsidian on PC ─ Richard's plugin ─┐
                                  ├─ Google Drive ─ Obsidian Drive MCP ─ Hermes
Obsidian on phone ─ Richard's plugin ┘
```

## Quick start: Windows

Requirements: Node.js 22 or newer, a Google account already syncing the vault, and a Google Cloud OAuth **Desktop app** client.

1. In Google Cloud Console, create/select a project, enable the Google Drive API, then create OAuth credentials with application type **Desktop app**. Keep the client ID and secret private.
2. In PowerShell, open this project folder and run:

```powershell
npm install
npm run build
npm run setup
npm run doctor
```

Setup asks for your OAuth client ID and secret (secret input is hidden in an interactive terminal), timezone, whether to opt in to startup auto-updates, and vault. It prints an authorization URL; open it in a browser, sign in with the same Google account Richard's plugin uses, and approve Drive access. If more than one compatible vault is found, choose the intended one—setup will not guess.

The default timezone is UTC. Enter an IANA name such as `Europe/London` or a fixed UTC offset such as `+4` or `-05:30`. Configuration and tokens are saved locally; after setup, the MCP does not need Google credentials in environment variables.

Optional local smoke test:

```powershell
npx @modelcontextprotocol/inspector node dist/src/launcher.js
```

## Install the connector in Hermes

Build and set up the connector first. Then, on the machine that runs Hermes, add it with Hermes' MCP command:

```bash
hermes mcp add obsidian --command node --args /path/to/hermes-obsidian-drive-mcp/dist/src/launcher.js
hermes mcp test obsidian
hermes mcp list
```

For example, if installed at `/opt/hermes-obsidian-drive-mcp`:

```bash
hermes mcp add obsidian --command node --args /opt/hermes-obsidian-drive-mcp/dist/src/launcher.js
hermes mcp test obsidian
```

Hermes may ask which tools to enable; choose all 11 or select your preferred set. Start a new Hermes session after registration so it loads the connector tools. Hermes' MCP support and CLI are documented in the [Hermes MCP guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md).

If using YAML instead of the CLI, merge the contents of [hermes-config.example.yaml](hermes-config.example.yaml) into the existing `mcp_servers:` map. Do not add a second nested `mcp_servers:` key.

## Install the Hermes skill

The skill is in `skills/obsidian-drive-mcp/SKILL.md`. It instructs Hermes to search before opening many notes, carry versions into writes, recover safely from conflicts, prefer patches/appends, and respect deletion and sync limitations.

Install the skill from the public repository with Hermes' skill tap:

```bash
hermes skills tap add leulwo/hermes-obsidian-drive-mcp
hermes skills install leulwo/hermes-obsidian-drive-mcp/obsidian-drive-mcp
hermes skills list
```

Start a new session after installing it. See the [Hermes skills guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md) for tap and skill-management details. You can also copy the skill directory to `~/.hermes/skills/obsidian-drive-mcp/`.

## VPS deployment

Use Node.js 22+ on Linux. The recommended flow is to authorize on the VPS through an SSH tunnel, avoiding manual transfer of refresh tokens:

1. Clone this repository to the VPS (required if you want the optional GitHub auto-updater; example destination: `/opt/hermes-obsidian-drive-mcp`).
2. In one terminal on your PC, keep this SSH tunnel open:

```bash
ssh -L 53682:127.0.0.1:53682 USER@YOUR_VPS
```

3. In another VPS session:

```bash
cd /opt/hermes-obsidian-drive-mcp
npm ci
npm run build
npm run setup
npm run doctor
```

4. Open the authorization URL printed by setup in your PC browser. The tunnel forwards Google's callback back to the VPS.
5. Register and test the MCP as shown above.

Configuration and OAuth tokens are stored under `~/.config/hermes-obsidian-drive-mcp/` on Linux. Keep these files private; restrict them to the Hermes account (`chmod 700 ~/.config/hermes-obsidian-drive-mcp && chmod 600 ~/.config/hermes-obsidian-drive-mcp/config.json ~/.config/hermes-obsidian-drive-mcp/token.json`). If you instead copy an already-authorized config from another machine, transfer it only over a secure channel and apply the same permissions. The config contains the OAuth client secret and the token file contains a refresh token.

### Updating an existing VPS install

After a tagged GitHub Release is published, keep the existing install available while testing the new one. This is especially useful if the original directory was copied to the VPS instead of cloned from Git:

```bash
cd /opt
git clone --branch v1.1.0 --depth 1 https://github.com/leulwo/hermes-obsidian-drive-mcp.git hermes-obsidian-drive-mcp-v1.1.0
cd /opt/hermes-obsidian-drive-mcp-v1.1.0
npm ci
npm run build
npm run doctor
```

The OAuth config/token stay in `/root/.config/hermes-obsidian-drive-mcp/`; do not replace or copy them during a code update. Once doctor passes, change the existing Hermes `obsidian` server command to `node` with args `/opt/hermes-obsidian-drive-mcp-v1.1.0/dist/src/launcher.js`, then run `hermes mcp test obsidian` and start a fresh Hermes session. Keep the old project directory until the new connector is verified. The launcher is what enables the optional release check/update at startup.

For later releases, you can either repeat this side-by-side deployment with the new tag, or use `npm run update` from a clean clone of this official repository. Auto-update is opt-in and also requires that clean Git clone; it will not update a copied/non-Git install.

Google OAuth apps left in **Testing** status may have refresh tokens that expire after seven days. For a persistent deployment, configure the consent screen and publishing status appropriate for your Google account.

## What the MCP provides

- `vault_context`: vault identity, note count, UTC/local time, and recent activity.
- `list_notes`, `search_notes`, `read_note`, `recent_changes`: discover and read notes.
- `patch_note`, `append_note`, `write_note`, `move_note`: safe edits to existing notes with optimistic concurrency.
- `note_history`: inspect Drive revisions.
- `delete_note`: enabled by default; it moves notes to Google Drive trash (not permanent deletion). Set `OBSIDIAN_ALLOW_DELETE=false` or `allowDelete: false` in config to disable it.

The connector intentionally does not create notes in Drive. Create a new note inside Obsidian, push it with Richard's plugin, then Hermes can read and edit it. This avoids relying on the plugin to adopt externally created files.

On a conflict, reread the note and reconcile newer phone/PC edits before retrying. Never blindly overwrite a newer version. Writes go to Google Drive immediately; visibility on phone and PC still depends on when Richard's plugin next pulls changes. Do not assume an open Obsidian device has already refreshed.

## Configuration and safety

Setup persists OAuth credentials, selected vault, and timezone in a cross-platform config file. Note deletion is enabled unless explicitly disabled in config or environment. Environment variables override persisted config when needed:

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OBSIDIAN_VAULT_NAME`, `OBSIDIAN_TIMEZONE`, `OBSIDIAN_ALLOW_DELETE`, and `OBSIDIAN_MCP_AUTO_UPDATE` (disabled by default).

Path overrides: `OBSIDIAN_MCP_CONFIG_DIR`, `OBSIDIAN_MCP_CONFIG_FILE`, and `OBSIDIAN_MCP_TOKEN_FILE`. Defaults use the OS config directory (normally `~/.config/hermes-obsidian-drive-mcp/` on Linux and `%APPDATA%/hermes-obsidian-drive-mcp/` on Windows; an existing legacy `~/.config` location is preserved).

`npm run doctor` is strictly read-only. It checks config, token refresh, Drive access, account, vault selection, timezone, and Richard-compatible metadata without writing, moving, or deleting Drive objects. Note deletion is enabled by default and moves notes to Drive trash; disable it with `OBSIDIAN_ALLOW_DELETE=false` (or `allowDelete: false` in config).

## Development and tests

```bash
npm ci
npm run build
npm test
```

The unit tests are offline and do not touch a real vault. The live Drive check is read-only and requires explicit opt-in:

```bash
OBSIDIAN_INTEGRATION_TEST=1 npm run test:integration
```

PowerShell:

```powershell
$env:OBSIDIAN_INTEGRATION_TEST = '1'
npm run test:integration
Remove-Item Env:OBSIDIAN_INTEGRATION_TEST
```

The integration test is a read-only live-auth and vault-discovery check. It does not create or modify notes.

## Richard plugin compatibility

This is a Drive-side client, not a generic Drive filesystem. It identifies vault roots and scopes files using the plugin's custom Drive properties, reconstructs Unicode-safe path chunks, creates compatible Drive folders, and preserves existing Drive file IDs on updates. The implementation has been checked against Richard Xiong's [drive helper](https://github.com/RichardX366/Obsidian-Google-Drive/blob/master/helpers/drive.ts) and [push helper](https://github.com/RichardX366/Obsidian-Google-Drive/blob/master/helpers/push.ts).

The MCP filters Obsidian/plugin configuration files and does not edit them. It does not promise immediate inbound sync to phone/PC; Richard's plugin controls pull timing.

## Versions and updates

Releases use Semantic Versioning: `1.1.0` → `1.2.0` for backward-compatible features, `1.1.1` for fixes, and `2.0.0` for breaking changes. Use `npm run version:minor`, `npm run version:patch`, or `npm run version:major` to bump `package.json` and the lockfile and synchronize the MCP/skill versions. Add a `CHANGELOG.md` entry, commit, then push a matching tag (for example `git tag v1.2.0; git push origin v1.2.0`). The GitHub Actions release workflow runs tests/build and publishes the GitHub Release the updater checks.

`npm run update:check` checks the latest stable GitHub release without changing files. `npm run update` applies it manually. Setup offers an opt-in to update automatically at MCP startup; alternatively set `OBSIDIAN_MCP_AUTO_UPDATE=true`. Auto-update requires a clean Git clone with the official repository as `origin`, checks only stable SemVer GitHub Releases, and never runs against modified/non-Git project folders. It builds the release before the MCP is loaded. If an update fails, it attempts to restore the prior checkout. Keep this disabled if you prefer to review each release yourself.
