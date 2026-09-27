#!/usr/bin/env bash
set -euo pipefail

DEST="${1:-/opt/hermes-obsidian-drive-mcp}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null; then
  echo "Node.js is required (22+)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required; found $(node -v)." >&2
  exit 1
fi

mkdir -p "$DEST"
if [[ "$SOURCE_DIR" != "$DEST" ]]; then
  cp -a "$SOURCE_DIR"/. "$DEST"/
fi
cd "$DEST"
npm install
npm run build

echo
echo "Installed to $DEST"
echo "Next: run the one-time interactive setup:"
echo "  cd $DEST && npm run setup"
echo "Then verify with: npm run doctor"
