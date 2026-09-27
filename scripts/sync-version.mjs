import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const indexPath = new URL('../src/index.ts', import.meta.url);
const index = fs.readFileSync(indexPath, 'utf8').replace(/(name: 'hermes-obsidian-drive', version: ')[^']+(')/, (_match, prefix, suffix) => `${prefix}${pkg.version}${suffix}`);
fs.writeFileSync(indexPath, index);

const skillPath = new URL('../skills/obsidian-drive-mcp/SKILL.md', import.meta.url);
const skill = fs.readFileSync(skillPath, 'utf8').replace(/^version: .*$/m, `version: ${pkg.version}`);
fs.writeFileSync(skillPath, skill);
console.log(`Synchronized MCP and skill metadata to ${pkg.version}. Update CHANGELOG.md and publish tag v${pkg.version}.`);
