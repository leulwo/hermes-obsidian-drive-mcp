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

Setup asks for your OAuth client ID and secret (secret input is hidden in an interactive terminal), timezone, and vault. It prints an authorization URL; open it in a browser, sign in with the same Google account Richard's plugin uses, and approve Drive access. If more than one compatible vault is found, choose the intended one—setup will not guess.

The default timezone is UTC. Enter an IANA name such as `Europe/London` or a fixed UTC offset such as `+4` or `-05:30`. Configuration and tokens are saved locally; after setup, the MCP does not need Google credentials in environment variables.

Optional local smoke test:

```powershell
npx @modelcontextprotocol/inspector node dist/src/index.js
```

## Install the connector in Hermes

Build and set up the connector first. Then, on the machine that runs Hermes, add it with Hermes' MCP command:

```bash
hermes mcp add obsidian --command node --args /path/to/hermes-obsidian-drive-mcp/dist/src/index.js
hermes mcp test obsidian
hermes mcp list
```

For example, if installed at `/opt/hermes-obsidian-drive-mcp`:

```bash
hermes mcp add obsidian --command node --args /opt/hermes-obsidian-drive-mcp/dist/src/index.js
hermes mcp test obsidian
```

Hermes may ask which tools to enable; choose all 12 or select your preferred set. Start a new Hermes session after registration so it loads the connector tools. Hermes' MCP support and CLI are documented in the [Hermes MCP guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md).

If using YAML instead of the CLI, merge the contents of [hermes-config.example.yaml](hermes-config.example.yaml) into the existing `mcp_servers:` map. Do not add a second nested `mcp_servers:` key.

## Install the Hermes skill

The skill is in `skills/obsidian-drive-mcp/SKILL.md`. It instructs Hermes to search before opening many notes, carry versions into writes, recover safely from conflicts, prefer patches/appends, and respect deletion and sync limitations.

After this repository is published as `OWNER/REPO`, install the skill with Hermes' skill tap:

```bash
hermes skills tap add OWNER/REPO
hermes skills install OWNER/REPO/obsidian-drive-mcp
hermes skills list
```

Start a new session after installing it. See the [Hermes skills guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md) for tap and skill-management details. You can also copy the skill directory to `~/.hermes/skills/obsidian-drive-mcp/`.

## VPS deployment

Use Node.js 22+ on Linux. The recommended flow is to authorize on the VPS through an SSH tunnel, avoiding manual transfer of refresh tokens:

1. Copy/clone this project to the VPS (example destination: `/opt/hermes-obsidian-drive-mcp`).
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

Google OAuth apps left in **Testing** status may have refresh tokens that expire after seven days. For a persistent deployment, configure the consent screen and publishing status appropriate for your Google account.

## What the MCP provides

- `vault_context`: vault identity, note count, UTC/local time, and recent activity.
- `list_notes`, `search_notes`, `read_note`, `recent_changes`: discover and read notes.
- `create_note`, `patch_note`, `append_note`, `write_note`, `move_note`: safe note operations with optimistic concurrency for edits.
- `note_history`: inspect Drive revisions.
- `delete_note`: registered but disabled by default; when explicitly enabled, it moves notes to Drive trash.

On a conflict, reread the note and reconcile newer phone/PC edits before retrying. Never blindly overwrite a newer version. Writes go to Google Drive immediately; visibility on phone and PC still depends on when Richard's plugin next pulls changes. Do not assume an open Obsidian device has already refreshed.

## Configuration and safety

Setup persists OAuth credentials, selected vault, timezone, and delete policy in a cross-platform config file. Environment variables override persisted config when needed:

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OBSIDIAN_VAULT_NAME`, `OBSIDIAN_TIMEZONE`, and `OBSIDIAN_ALLOW_DELETE`.

Path overrides: `OBSIDIAN_MCP_CONFIG_DIR`, `OBSIDIAN_MCP_CONFIG_FILE`, and `OBSIDIAN_MCP_TOKEN_FILE`. Defaults use the OS config directory (normally `~/.config/hermes-obsidian-drive-mcp/` on Linux and `%APPDATA%/hermes-obsidian-drive-mcp/` on Windows; an existing legacy `~/.config` location is preserved).

`npm run doctor` is strictly read-only. It checks config, token refresh, Drive access, account, vault selection, timezone, and Richard-compatible metadata without writing, moving, or deleting Drive objects. Deletes are off by default.

## Development and tests

```bash
npm ci
npm run build
npm test
```

The unit tests are offline and do not touch a real vault. Live Drive round trips require explicit opt-in:

```bash
OBSIDIAN_INTEGRATION_TEST=1 npm run test:integration
```

PowerShell:

```powershell
$env:OBSIDIAN_INTEGRATION_TEST = '1'
npm run test:integration
Remove-Item Env:OBSIDIAN_INTEGRATION_TEST
```

The integration test creates, patches, appends to, and moves a unique temporary note. If deletion is disabled, it leaves the note in Drive and prints its path for manual cleanup; if deletion is enabled, it moves that test note to Drive trash.

## Richard plugin compatibility

This is a Drive-side client, not a generic Drive filesystem. It identifies vault roots and scopes files using the plugin's custom Drive properties, reconstructs Unicode-safe path chunks, creates compatible Drive folders, and preserves existing Drive file IDs on updates. The implementation has been checked against Richard Xiong's [drive helper](https://github.com/RichardX366/Obsidian-Google-Drive/blob/master/helpers/drive.ts) and [push helper](https://github.com/RichardX366/Obsidian-Google-Drive/blob/master/helpers/push.ts).

The MCP filters Obsidian/plugin configuration files and does not edit them. It does not promise immediate inbound sync to phone/PC; Richard's plugin controls pull timing.
