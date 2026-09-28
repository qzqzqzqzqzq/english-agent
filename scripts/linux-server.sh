#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This launcher is for Linux.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf 'Node.js 24+ and npm are required.\n' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ is required."); process.exit(1); }'

if [[ ! -d node_modules ]]; then npm ci; fi
npm run build

export DATA_DIR="${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/english-agent}"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
export ACCESS_PASSWORD_FILE="${ACCESS_PASSWORD_FILE:-$DATA_DIR/access-password}"
if [[ ! -f "$ACCESS_PASSWORD_FILE" ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")' > "$ACCESS_PASSWORD_FILE"
fi
chmod 600 "$ACCESS_PASSWORD_FILE"
export PORT="${PORT:-3001}"
printf 'English Agent will listen on http://127.0.0.1:%s\n' "$PORT"
printf 'Browser login: english; password is stored in %s (do not share it).\n' "$ACCESS_PASSWORD_FILE"
exec node --import tsx server/index.ts
