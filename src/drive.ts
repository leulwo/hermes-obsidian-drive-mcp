import { type OAuth2Client } from 'google-auth-library';
import { config, redactSecrets } from './config.js';
import { basename, dirname, normalizeVaultPath, splitPath, unSplitPath } from './path.js';
import { assertDeleteEnabled, assertVersion } from './note-ops.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  version?: string;
  size?: string;
  md5Checksum?: string;
  properties?: Record<string, string>;
  parents?: string[];
  trashed?: boolean;
  description?: string;
}

export interface VaultInfo {
  name: string;
  rootId: string;
}

export function isVaultFile(file: DriveFile, vaultName: string, includeConfig = false): boolean {
  return file.properties?.vault === vaultName && file.properties?.obsidian !== 'vault' && (includeConfig || file.properties?.config !== 'true');
}

export function selectVault(vaults: VaultInfo[], configured?: string): VaultInfo {
  if (configured) {
    const match = vaults.find((vault) => vault.name === configured);
    if (!match) throw new Error(`Configured vault ${JSON.stringify(configured)} was not found. Available: ${vaults.map((v) => v.name).join(', ') || '(none)'}`);
    return match;
  }
  if (vaults.length === 1) return vaults[0]!;
  if (!vaults.length) throw new Error('No Richard Google Drive Sync vault root was found in this Google Drive account.');
  throw new Error(`Multiple synced vaults found (${vaults.map((v) => v.name).join(', ')}). Run npm run setup to choose one.`);
}

interface ListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

function escapeQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export class DriveBridge {
  private selectedVault?: VaultInfo;

  constructor(private readonly auth: OAuth2Client) {}

  private async accessToken(): Promise<string> {
    const { token } = await this.auth.getAccessToken();
    if (!token) throw new Error('Google OAuth did not return an access token. Re-run npm run auth.');
    return token;
  }

  private async request<T>(
    url: string,
    init: RequestInit = {},
    options: { raw?: boolean } = {},
  ): Promise<T> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(redactSecrets(`Google Drive API ${response.status} ${response.statusText}: ${body.slice(0, 1200)}`, [token]));
    }
    if (options.raw) return response as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private fields(): string {
    return 'id,name,mimeType,modifiedTime,createdTime,version,size,md5Checksum,properties,parents,trashed,description';
  }

  async listAll(q: string, orderBy?: string, pageSize = 1000): Promise<DriveFile[]> {
    const all: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        pageSize: String(Math.min(pageSize, 1000)),
        fields: `nextPageToken,files(${this.fields()})`,
        spaces: 'drive',
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request<ListResponse>(`https://www.googleapis.com/drive/v3/files?${params}`);
      all.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }

  async discoverVaults(): Promise<VaultInfo[]> {
    const q = "trashed=false and properties has { key='obsidian' and value='vault' }";
    const roots = await this.listAll(q, 'name');
    return roots
      .filter((file) => file.mimeType === FOLDER_MIME)
      .map((file) => ({ name: file.properties?.vault || file.name, rootId: file.id }));
  }

  async vault(): Promise<VaultInfo> {
    if (this.selectedVault) return this.selectedVault;
    const vaults = await this.discoverVaults();
    this.selectedVault = selectVault(vaults, config.vaultName);
    return this.selectedVault;
  }

  async allVaultFiles(options: { notesOnly?: boolean; includeConfig?: boolean } = {}): Promise<DriveFile[]> {
    const vault = await this.vault();
    let q = `trashed=false and properties has { key='vault' and value='${escapeQuery(vault.name)}' }`;
    if (options.notesOnly) q += ` and mimeType!='${FOLDER_MIME}'`;
    const files = await this.listAll(q, 'name');
    return files.filter((file) => isVaultFile(file, vault.name, options.includeConfig));
  }

  async fileByPath(rawPath: string): Promise<DriveFile | undefined> {
    const vault = await this.vault();
    const p = normalizeVaultPath(rawPath);
    const pathProps = splitPath(p);
    const propQuery = Object.entries(pathProps)
      .map(([key, value]) => `properties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`)
      .join(' and ');
    const q = `trashed=false and properties has { key='vault' and value='${escapeQuery(vault.name)}' } and ${propQuery}`;
    const files = await this.listAll(q);
    const exact = files.filter((f) => unSplitPath(f.properties) === p);
    if (exact.length > 1) {
      throw new Error(`Ambiguous vault state: ${exact.length} Drive items claim the same Obsidian path ${p}. Resolve the duplicate before writing.`);
    }
    return exact[0];
  }

  async folderByPath(rawPath: string): Promise<DriveFile | undefined> {
    if (!rawPath) {
      const vault = await this.vault();
      return {
        id: vault.rootId,
        name: vault.name,
        mimeType: FOLDER_MIME,
        properties: { obsidian: 'vault', vault: vault.name },
      };
    }
    const result = await this.fileByPath(rawPath);
    return result?.mimeType === FOLDER_MIME ? result : undefined;
  }

  async ensureFolder(rawPath: string): Promise<DriveFile> {
    const vault = await this.vault();
    const p = rawPath ? normalizeVaultPath(rawPath) : '';
    if (!p) {
      return { id: vault.rootId, name: vault.name, mimeType: FOLDER_MIME };
    }

    let parentId = vault.rootId;
    let current = '';
    let result: DriveFile | undefined;
    for (const segment of p.split('/')) {
      current = current ? `${current}/${segment}` : segment;
      result = await this.folderByPath(current);
      if (result) {
        parentId = result.id;
        continue;
      }
      result = await this.createFolder(current, parentId);
      parentId = result.id;
    }
    return result!;
  }

  private async createFolder(p: string, parentId: string): Promise<DriveFile> {
    const vault = await this.vault();
    const now = new Date().toISOString();
    const metadata = {
      name: basename(p),
      mimeType: FOLDER_MIME,
      parents: [parentId],
      properties: { ...splitPath(p), vault: vault.name },
      modifiedTime: now,
    };
    return this.request<DriveFile>('https://www.googleapis.com/drive/v3/files?fields=' + encodeURIComponent(this.fields()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  async readContent(file: DriveFile): Promise<string> {
    const response = await this.request<Response>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&acknowledgeAbuse=true`,
      {},
      { raw: true },
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.maxNoteBytes) {
      throw new Error(`Note is ${buffer.length} bytes, exceeding OBSIDIAN_MAX_NOTE_BYTES=${config.maxNoteBytes}.`);
    }
    return buffer.toString('utf8');
  }

  async metadataById(id: string): Promise<DriveFile> {
    return this.request<DriveFile>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(this.fields())}`,
    );
  }

  private async multipartUpload(id: string, metadata: object, content: string): Promise<DriveFile> {
    const boundary = `hermes_${crypto.randomUUID()}`;
    const metadataJson = JSON.stringify(metadata);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const base = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}`;
    const params = new URLSearchParams({ uploadType: 'multipart', fields: this.fields() });
    return this.request<DriveFile>(`${base}?${params}`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async assertFresh(file: DriveFile, expectedVersion?: string, expectedModifiedTime?: string): Promise<DriveFile> {
    const latest = await this.metadataById(file.id);
    assertVersion(expectedVersion, latest.version, unSplitPath(latest.properties));
    if (expectedModifiedTime && latest.modifiedTime !== expectedModifiedTime) {
      throw new Error(`Conflict: ${unSplitPath(latest.properties)} changed since it was read. Expected modifiedTime ${expectedModifiedTime}, current is ${latest.modifiedTime}. Re-read before writing.`);
    }
    return latest;
  }

  async writeNote(
    rawPath: string,
    content: string,
    options: { expectedVersion?: string; expectedModifiedTime?: string } = {},
  ): Promise<DriveFile> {
    const p = normalizeVaultPath(rawPath, { requireMarkdown: true });
    const file = await this.fileByPath(p);
    if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}. This connector edits existing notes only; create new notes in Obsidian and push them with Richard's plugin first.`);
    if (Buffer.byteLength(content, 'utf8') > config.maxNoteBytes) throw new Error('Content exceeds OBSIDIAN_MAX_NOTE_BYTES.');
    await this.assertFresh(file, options.expectedVersion, options.expectedModifiedTime);
    return this.multipartUpload(file.id, { modifiedTime: new Date().toISOString() }, content);
  }

  async moveNote(
    rawFrom: string,
    rawTo: string,
    options: { expectedVersion?: string; expectedModifiedTime?: string } = {},
  ): Promise<DriveFile> {
    const vault = await this.vault();
    const from = normalizeVaultPath(rawFrom, { requireMarkdown: true });
    const to = normalizeVaultPath(rawTo, { requireMarkdown: true });
    if (from === to) throw new Error('Source and destination paths are the same.');
    const file = await this.fileByPath(from);
    if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${from}`);
    if (await this.fileByPath(to)) throw new Error(`Destination already exists: ${to}`);
    await this.assertFresh(file, options.expectedVersion, options.expectedModifiedTime);
    const parent = await this.ensureFolder(dirname(to));
    const oldParents = file.parents?.join(',');
    const params = new URLSearchParams({ fields: this.fields() });
    params.set('addParents', parent.id);
    if (oldParents) params.set('removeParents', oldParents);
    const newPathProperties = splitPath(to);
    const stalePathProperties = Object.keys(file.properties ?? {})
      .filter((key) => /^path\d*$/.test(key) && !(key in newPathProperties))
      .reduce<Record<string, null>>((acc, key) => {
        acc[key] = null;
        return acc;
      }, {});

    return this.request<DriveFile>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?${params}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: basename(to),
        properties: { ...newPathProperties, ...stalePathProperties, vault: vault.name },
        modifiedTime: new Date().toISOString(),
      }),
    });
  }

  async deleteNote(rawPath: string, expectedVersion?: string): Promise<void> {
    assertDeleteEnabled(config.allowDelete);
    const p = normalizeVaultPath(rawPath, { requireMarkdown: true });
    const file = await this.fileByPath(p);
    if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}`);
    await this.assertFresh(file, expectedVersion, undefined);
    await this.request<DriveFile>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=${encodeURIComponent(this.fields())}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true, modifiedTime: new Date().toISOString() }),
    });
  }

  async revisions(rawPath: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const p = normalizeVaultPath(rawPath, { requireMarkdown: true });
    const file = await this.fileByPath(p);
    if (!file || file.mimeType === FOLDER_MIME) throw new Error(`Note not found: ${p}`);
    const result = await this.request<{ revisions?: Array<Record<string, unknown>> }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/revisions?pageSize=${Math.min(limit, 100)}&fields=revisions(id,modifiedTime,keepForever,size,md5Checksum,lastModifyingUser(displayName,emailAddress))`,
    );
    return result.revisions ?? [];
  }

  async recentChanges(sinceIso: string, limit: number): Promise<DriveFile[]> {
    const vault = await this.vault();
    const date = new Date(sinceIso);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid since timestamp: ${sinceIso}`);
    const q = `trashed=false and properties has { key='vault' and value='${escapeQuery(vault.name)}' } and modifiedTime>'${date.toISOString()}'`;
    const files = await this.listAll(q, 'modifiedTime desc');
    return files
      .filter((f) => f.properties?.obsidian !== 'vault' && f.properties?.config !== 'true')
      .slice(0, limit);
  }

  noteSummary(file: DriveFile) {
    return {
      path: unSplitPath(file.properties),
      id: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      version: file.version,
      size: file.size ? Number(file.size) : undefined,
    };
  }

  debugFile(file: DriveFile): string {
    return jsonText({ ...this.noteSummary(file), properties: file.properties, parents: file.parents });
  }
}
