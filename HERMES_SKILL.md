# Obsidian Drive MCP — Hermes usage skill

Use the `obsidian` MCP as the user's live cloud-backed Obsidian vault.

## Operating rules

1. Prefer `vault_context` when the request depends on “today”, “recent”, vault identity, or current sync context.
2. Use `list_notes` before broad reads when you need to discover paths.
3. Use `search_notes` for topic/content discovery instead of guessing filenames.
4. `read_note` returns `version` and `modifiedTime`. Preserve `version` when planning a later full write or move.
5. Prefer `patch_note` for small targeted edits and `append_note` for journals/logs. They automatically guard against concurrent changes.
6. Use `write_note` for deliberate full-document replacement. When the note was read earlier, pass `expected_version`.
7. Never recreate an existing note with `create_note`; it intentionally fails instead of overwriting.
8. Treat conflict errors as useful safety signals: re-read, reconcile the user's newer content, then retry.
9. Do not call `delete_note` unless deletion is explicitly required. It is disabled by default anyway.
10. Successful writes return updated Drive metadata; use that result instead of immediately re-reading unless content verification is needed.

For “what changed today”, call `vault_context` to get the configured local date, then use `recent_changes` with an ISO timestamp or a duration such as `hours: 3` or `days: 1`. With no time argument, `recent_changes` checks the last 24 hours.

## Time

The server reports both UTC and the configured local timezone. Use `vault_context.now.local_date` and `local_time` for date-sensitive note names or journal entries rather than assuming the VPS timezone.

## Sync model

The MCP talks directly to the same Google Drive representation used by Richard Xiong's Google Drive Sync plugin. It does not run Obsidian on the VPS. Changes are immediately present in Drive; phone/PC visibility still depends on Richard's next pull. Do not assume an open Obsidian device has already pulled a change.
