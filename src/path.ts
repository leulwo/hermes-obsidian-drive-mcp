const encoder = new TextEncoder();

/** Exact compatibility with Richard Xiong's splitPath() implementation. */
export function splitPath(obsidianPath: string): Record<string, string> {
  let chunk = '';
  const output: Record<string, string> = {};
  let index = 1;

  for (const char of obsidianPath) {
    if (encoder.encode(chunk + char).length > 100) {
      output[index === 1 ? 'path' : `path${index}`] = chunk;
      chunk = '';
      index += 1;
    }
    chunk += char;
  }

  output[index === 1 ? 'path' : `path${index}`] = chunk;
  return output;
}

export function unSplitPath(properties: Record<string, string> | undefined): string {
  if (!properties) return '';
  let result = properties.path ?? '';
  let index = 2;
  while (properties[`path${index}`]) {
    result += properties[`path${index}`];
    index += 1;
  }
  return result;
}

export function normalizeVaultPath(input: string, options: { requireMarkdown?: boolean } = {}): string {
  let p = input.trim().replaceAll('\\', '/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!p) throw new Error('Path cannot be empty.');
  if (p.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new Error(`Unsafe or invalid vault path: ${input}`);
  }
  if (options.requireMarkdown && !p.toLowerCase().endsWith('.md')) p += '.md';
  return p;
}

export function dirname(obsidianPath: string): string {
  const parts = obsidianPath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

export function basename(obsidianPath: string): string {
  return obsidianPath.split('/').at(-1) ?? obsidianPath;
}
