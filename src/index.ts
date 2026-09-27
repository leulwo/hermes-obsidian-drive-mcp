import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createAuthedClient } from './auth-lib.js';
import { config } from './config.js';
import { DriveBridge, FOLDER_MIME, type DriveFile } from './drive.js';
import { normalizeVaultPath, unSplitPath } from './path.js';
import { formatInTimezone, timeContext } from './time.js';
import { replaceExact } from './note-ops.js';

const auth = await createAuthedClient();
const drive = new DriveBridge(auth);
const server = new McpServer(
  { name: 'hermes-obsidian-drive', version: '1.1.1' },
  {
    instructions:
      'This server edits the live Google Drive representation used by Richard Xiong Google Drive Sync. Call vault_context when vault identity, local time, or recent context matters. Search before opening many notes; do not guess paths when listing or search can resolve them. Read before modifying, carry the returned version, prefer patch_note for small edits and append_note for journals/logs, and use write_note only for intentional full replacement. On conflict, reread and reconcile the newer content. Do not delete unless explicitly asked. A Drive write may not appear on a phone/PC until Richard’s plugin pulls changes.',
  },
);

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function withLocalTime(file: DriveFile) {
  return {
    ...drive.noteSummary(file),
    modifiedLocal: formatInTimezone(file.modifiedTime, config.timezone),
    createdLocal: formatInTimezone(file.createdTime, config.timezone),
  };
}

function safeTool<T>(fn: () => Promise<T>) {
  return fn().then(textResult).catch(errorResult);
}

server.registerTool('vault_context', {
  description: 'Get the selected Obsidian vault, current UTC/local time, timezone, note count, recent notes, delete policy, and available synced vaults. Call this when time context, vault identity, or sync context matters.',
  inputSchema: z.object({ recent_limit: z.number().int().min(0).max(25).default(8) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ recent_limit }) => safeTool(async () => {
  const vaults = await drive.discoverVaults();
  const vault = await drive.vault();
  const files = await drive.allVaultFiles({ notesOnly: true });
  const notes = files.filter((f) => f.mimeType !== FOLDER_MIME && unSplitPath(f.properties).toLowerCase().endsWith('.md'));
  notes.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  return {
    vault,
    available_vaults: vaults,
    now: timeContext(config.timezone),
    note_count: notes.length,
    recent_notes: notes.slice(0, recent_limit).map(withLocalTime),
    delete_enabled: config.allowDelete,
    sync_model: 'Direct Google Drive compatibility bridge for Richard Xiong Obsidian Google Drive Sync metadata.',
  };
}));

server.registerTool('list_notes', {
  description: 'List Markdown notes by vault path without reading note bodies. Prefix is an Obsidian folder/path prefix. Useful for browsing structure cheaply.',
  inputSchema: z.object({
    prefix: z.string().default(''),
    limit: z.number().int().min(1).max(1000).default(200),
    sort: z.enum(['path', 'modified_desc', 'modified_asc']).default('path'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ prefix, limit, sort }) => safeTool(async () => {
  const normalizedPrefix = prefix.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  let notes = (await drive.allVaultFiles({ notesOnly: true }))
    .filter((f) => unSplitPath(f.properties).toLowerCase().endsWith('.md'))
    .filter((f) => !normalizedPrefix || unSplitPath(f.properties).startsWith(normalizedPrefix));
  if (sort === 'path') notes.sort((a, b) => unSplitPath(a.properties).localeCompare(unSplitPath(b.properties)));
  else notes.sort((a, b) => (a.modifiedTime ?? '').localeCompare(b.modifiedTime ?? '') * (sort === 'modified_desc' ? -1 : 1));
  return { count: Math.min(notes.length, limit), total_matches: notes.length, notes: notes.slice(0, limit).map(withLocalTime) };
}));

server.registerTool('read_note', {
  description: 'Read one note by Obsidian path. Returns content plus Drive version and modifiedTime; pass those back to later writes for conflict protection.',
  inputSchema: z.object({ path: z.string().min(1) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ path }) => safeTool(async () => {
  const p = normalizeVaultPath(path, { requireMarkdown: true });
  const file = await drive.fileByPath(p);
  if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}`);
  return { ...withLocalTime(file), content: await drive.readContent(file) };
}));

server.registerTool('search_notes', {
  description: 'Search note paths and Markdown content. This performs reliable content scanning rather than relying only on Google Drive full-text indexing. Returns snippets and metadata.',
  inputSchema: z.object({
    query: z.string().min(1),
    prefix: z.string().default(''),
    limit: z.number().int().min(1).max(100).default(20),
    case_sensitive: z.boolean().default(false),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, prefix, limit, case_sensitive }) => safeTool(async () => {
  const needle = case_sensitive ? query : query.toLowerCase();
  const normalizedPrefix = prefix.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  const candidates = (await drive.allVaultFiles({ notesOnly: true }))
    .filter((f) => unSplitPath(f.properties).toLowerCase().endsWith('.md'))
    .filter((f) => !normalizedPrefix || unSplitPath(f.properties).startsWith(normalizedPrefix))
    .slice(0, config.searchMaxFiles);

  const hits: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(config.searchConcurrency, candidates.length || 1) }, async () => {
    while (cursor < candidates.length && hits.length < limit) {
      const file = candidates[cursor++];
      const p = unSplitPath(file.properties);
      const pathHay = case_sensitive ? p : p.toLowerCase();
      let content = '';
      let index = pathHay.indexOf(needle);
      let matchedIn = 'path';
      if (index < 0) {
        content = await drive.readContent(file);
        const hay = case_sensitive ? content : content.toLowerCase();
        index = hay.indexOf(needle);
        matchedIn = 'content';
      }
      if (index < 0) continue;
      if (!content) content = await drive.readContent(file);
      const snippetStart = Math.max(0, index - 180);
      const snippetEnd = Math.min(content.length, index + query.length + 320);
      hits.push({ ...withLocalTime(file), matched_in: matchedIn, snippet: content.slice(snippetStart, snippetEnd) });
    }
  });
  await Promise.all(workers);
  hits.sort((a, b) => String(b.modifiedTime ?? '').localeCompare(String(a.modifiedTime ?? '')));
  return { query, scanned: candidates.length, count: hits.slice(0, limit).length, results: hits.slice(0, limit) };
}));

server.registerTool('recent_changes', {
  description: 'List notes/folders changed recently. Provide one of since (ISO-8601), hours, or days; defaults to the last 24 hours.',
  inputSchema: z.object({
    since: z.string().min(1).optional().describe('ISO-8601 timestamp'),
    hours: z.number().positive().max(8760).optional(),
    days: z.number().positive().max(365).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ since, hours, days, limit }) => safeTool(async () => {
  if ([since, hours, days].filter(value => value !== undefined).length > 1) throw new Error('Provide only one of since, hours, or days.');
  const duration = hours !== undefined ? hours * 3600_000 : (days ?? 1) * 86400_000;
  const sinceUtc = since ?? new Date(Date.now() - duration).toISOString();
  const files = await drive.recentChanges(sinceUtc, limit);
  return { since_utc: new Date(sinceUtc).toISOString(), now: timeContext(config.timezone), count: files.length, changes: files.map(withLocalTime) };
}));

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expected_version: z.string().optional().describe('Recommended: version returned by read_note. Prevents overwriting a newer phone/PC edit.'),
  expected_modified_time: z.string().optional().describe('Alternative conflict guard using modifiedTime returned by read_note.'),
});

server.registerTool('write_note', {
  description: 'Replace an existing note body. Use expected_version from read_note whenever doing read-modify-write to prevent clobbering newer edits.',
  inputSchema: writeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ path, content, expected_version, expected_modified_time }) => safeTool(async () => ({
  action: 'written',
  ...withLocalTime(await drive.writeNote(path, content, { expectedVersion: expected_version, expectedModifiedTime: expected_modified_time })),
})));

server.registerTool('append_note', {
  description: 'Append text to an existing note. Reads latest content first and uses its Drive version as a conflict guard before writing.',
  inputSchema: z.object({ path: z.string().min(1), text: z.string(), ensure_newline: z.boolean().default(true) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ path, text, ensure_newline }) => safeTool(async () => {
  const p = normalizeVaultPath(path, { requireMarkdown: true });
  const file = await drive.fileByPath(p);
  if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}`);
  const current = await drive.readContent(file);
  const separator = ensure_newline && current && !current.endsWith('\n') ? '\n' : '';
  const updated = await drive.writeNote(p, current + separator + text, { expectedVersion: file.version });
  return { action: 'appended', ...withLocalTime(updated) };
}));

server.registerTool('patch_note', {
  description: 'Safely replace an exact text fragment inside a note. Best for surgical edits because it fails if the target text is absent or ambiguous unless replace_all=true.',
  inputSchema: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().default(false),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ path, old_text, new_text, replace_all }) => safeTool(async () => {
  const p = normalizeVaultPath(path, { requireMarkdown: true });
  const file = await drive.fileByPath(p);
  if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}`);
  const current = await drive.readContent(file);
  const patch = replaceExact(current, old_text, new_text, replace_all);
  const updated = await drive.writeNote(p, patch.content, { expectedVersion: file.version });
  return { action: 'patched', replacements: patch.replacements, ...withLocalTime(updated) };
}));

server.registerTool('move_note', {
  description: 'Rename or move a note while preserving its Drive identity and updating Richard-compatible path metadata. Creates missing destination folders.',
  inputSchema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    expected_version: z.string().optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ from, to, expected_version }) => safeTool(async () => ({
  action: 'moved',
  from,
  ...withLocalTime(await drive.moveNote(from, to, { expectedVersion: expected_version })),
})));

server.registerTool('note_history', {
  description: 'List Google Drive revisions for a note. Useful before/after important edits or when investigating accidental changes.',
  inputSchema: z.object({ path: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ path, limit }) => safeTool(async () => ({ path: normalizeVaultPath(path, { requireMarkdown: true }), revisions: await drive.revisions(path, limit) })));

server.registerTool('delete_note', {
  description: 'Move a note to Google Drive trash so Richard sync can propagate its deletion. Enabled by default; set OBSIDIAN_ALLOW_DELETE=false to disable. Use only when the user explicitly requests deletion; optionally pass expected_version as a conflict guard.',
  inputSchema: z.object({ path: z.string().min(1), expected_version: z.string().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ path, expected_version }) => safeTool(async () => {
  await drive.deleteNote(path, expected_version);
  return { action: 'deleted', path: normalizeVaultPath(path, { requireMarkdown: true }), at: timeContext(config.timezone) };
}));

const transport = new StdioServerTransport();
await server.connect(transport);
