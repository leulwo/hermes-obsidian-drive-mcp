---
name: obsidian-drive-mcp
description: Use the user's live Obsidian vault through the Richard-compatible Google Drive MCP safely and efficiently.
version: 1.1.1
author: VaporGrid
platforms: [linux]
metadata:
  hermes:
    tags: [obsidian, notes, google-drive, mcp, productivity]
    category: productivity
---

# Obsidian Drive MCP

Use this skill whenever the user asks to read, find, summarize, organize, update, append to, rename, or inspect recent changes in their Obsidian notes through the `obsidian` MCP server.

## Safe workflow

- For today/yesterday/recent questions, call `vault_context` first and use its configured local date/time.
- Discover paths with `list_notes` or `search_notes`; do not guess when the vault can resolve them.
- This connector does not create new notes. Ask the user to create the note in Obsidian and push it with Richard's plugin, then locate it with `list_notes` or `search_notes`.
- Read the note before editing and carry its returned version into a later write or move.
- Prefer `patch_note` for small exact edits and `append_note` for journals/logs. Use `write_note` only for intentional full-document replacement.
- On a conflict, reread, reconcile newer phone/PC edits, then retry. Never blindly overwrite.
- Use `note_history` when reviewing revisions or recovering from an accidental edit.
- Do not delete unless explicitly requested; deletion is enabled by default and moves notes to Google Drive trash (not permanent deletion).
- Successful writes reach Drive immediately, but device visibility waits for Richard's plugin to pull. Do not claim that an open phone or PC has already synced.

## Time and sync

`vault_context` returns UTC and configured local time. For date-sensitive note names or journal text, use its local date/time instead of the server clock. For “what changed today” or “in the last few hours”, follow `vault_context` with `recent_changes` using an ISO timestamp, `hours`, or `days`; the default is the last 24 hours.

The MCP talks directly to the Google Drive representation created by Richard Xiong's plugin. It does not run Obsidian on the VPS and does not guarantee immediate inbound sync to phone/PC.
