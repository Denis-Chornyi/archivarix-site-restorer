#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

clear
printf '773 Site Restorer\n'
printf '=================\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js не знайдено.\n'
  printf 'Встановіть Node.js 18 або новіший з https://nodejs.org/\n\n'
  read -r -p 'Натисніть Enter, щоб закрити вікно...'
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf 'Потрібен Node.js 18 або новіший. Зараз встановлено: '
  node --version
  printf '\n'
  read -r -p 'Натисніть Enter, щоб закрити вікно...'
  exit 1
fi

printf 'Запускаю програму на http://127.0.0.1:4321\n'
printf 'Не закривайте це вікно, поки користуєтеся програмою.\n\n'
exec node server.js
