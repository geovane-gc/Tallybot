#!/usr/bin/env bash
#
# Prepares ./data and validates the configuration before the container starts.
# Idempotent.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DATA="$ROOT/data"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  yellow "Created .env from .env.example."
  red    "Fill in OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS."
  echo   "Instructions: docs/setup.md"
  exit 1
fi

# Host UID/GID, so files created under data/ stay editable outside the container.
if grep -qE '^HERMES_UID=$' "$ROOT/.env"; then
  sed -i.bak "s/^HERMES_UID=$/HERMES_UID=$(id -u)/" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  green "HERMES_UID=$(id -u) written to .env"
fi
if grep -qE '^HERMES_GID=$' "$ROOT/.env"; then
  sed -i.bak "s/^HERMES_GID=$/HERMES_GID=$(id -g)/" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  green "HERMES_GID=$(id -g) written to .env"
fi

missing=()
for var in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
  value="$(grep -E "^${var}=" "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [[ -z "$value" ]] && missing+=("$var")
done

if (( ${#missing[@]} > 0 )); then
  red "Missing variables in .env: ${missing[*]}"
  echo "See docs/setup.md."
  exit 1
fi

mkdir -p "$DATA"/{skills,finance,logs}

# Hermes reads secrets from /opt/data/.env inside the container.
cp "$ROOT/.env" "$DATA/.env"
chmod 600 "$DATA/.env"

# Overwritten on every bootstrap so that hermes/ is the source of truth and
# changes stay under version control.
cp "$ROOT/hermes/config.yaml" "$DATA/config.yaml"
cp "$ROOT/hermes/SOUL.md"     "$DATA/SOUL.md"
green "config.yaml and SOUL.md synced from hermes/ into data/"

node "$ROOT/skills/finance/scripts/fin.ts" \
  --db "$DATA/finance/tally.db" init >/dev/null
green "Database ready at data/finance/tally.db"

green "Bootstrap complete."
