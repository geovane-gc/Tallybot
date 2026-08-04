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
  chmod 600 "$ROOT/.env"
  yellow "Created .env from .env.example."
  red    "Fill in OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS"
  red    "and TALLY_ACCESS_CODE (generate one with: openssl rand -base64 24)."
  echo   "Instructions: docs/setup.md"
  exit 1
fi

# The file holds the OpenRouter key, the bot token and the access code, so it is
# nobody else's business on a shared host. Applied on every run, not just on
# creation, in case it was created by hand.
chmod 600 "$ROOT/.env"

# Rewrite one blank `VAR=` line in place.
#
# Deliberately NOT `sed -i.bak`: that leaves a .env.bak holding every secret, and
# the follow-up `rm` never runs if sed fails or the operator hits Ctrl-C. That
# stray file is world-readable and, before `.gitignore` learned about `.env*`, was
# committable. mktemp starts at 600 and mv keeps it, so the secret is never
# readable by anyone else even for an instant.
set_env_default() {
  local var="$1" value="$2" tmp
  grep -qE "^${var}=$" "$ROOT/.env" || return 0
  tmp="$(mktemp "${TMPDIR:-/tmp}/tally-env.XXXXXX")"
  sed "s|^${var}=$|${var}=${value}|" "$ROOT/.env" >"$tmp"
  mv "$tmp" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  green "${var}=${value} written to .env"
}

# Host UID/GID, so files created under data/ stay editable outside the container.
set_env_default HERMES_UID "$(id -u)"
set_env_default HERMES_GID "$(id -g)"

# TALLY_ACCESS_CODE gates the ledger itself: without it every finance command
# refuses to run, so a blank value is a broken bot rather than a lax one.
missing=()
for var in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TALLY_ACCESS_CODE; do
  value="$(grep -E "^${var}=" "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [[ -z "$value" ]] && missing+=("$var")
done

if (( ${#missing[@]} > 0 )); then
  red "Missing variables in .env: ${missing[*]}"
  if [[ " ${missing[*]} " == *" TALLY_ACCESS_CODE "* ]]; then
    echo "Generate the access code with: openssl rand -base64 24"
    echo "Both people type it once, on their first message to the bot."
  fi
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
