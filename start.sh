#!/usr/bin/env sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не знайдено. Встановіть Node.js 18 або новіший: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Потрібен Node.js 18 або новіший. Встановлено: $(node --version)"
  exit 1
fi

exec node server.js
