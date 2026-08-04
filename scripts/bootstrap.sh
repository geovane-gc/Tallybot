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

env_value() {
  grep -E "^${1}=" "$ROOT/.env" | head -1 | cut -d= -f2- || true
}

missing=()
for var in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
  [[ -z "$(env_value "$var")" ]] && missing+=("$var")
done

if (( ${#missing[@]} > 0 )); then
  red "Missing variables in .env: ${missing[*]}"
  echo "See docs/setup.md."
  exit 1
fi

# TALLY_ACCESS_CODE is deliberately NOT in the list above.
#
# It is the shared code, and the whole point of per-person invites is that it can
# be deleted once everybody has redeemed one — a standing secret in the
# environment is a secret the agent can print with `env` months later. Failing the
# bootstrap over its absence would make the recommended end state impossible.
#
# What is still an error is nobody being able to get in *at all*: no shared code,
# nobody registered, and no invite ever minted. That is checked below, after the
# database exists.
access_code="$(env_value TALLY_ACCESS_CODE)"

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

# --- how people get in -------------------------------------------------------
if [[ -z "$access_code" ]]; then
  fin() {
    node "$ROOT/skills/finance/scripts/fin.ts" \
      --db "$DATA/finance/tally.db" "$@" 2>/dev/null || echo '{}'
  }
  # Parsing in node rather than jq: jq is not in the Hermes image and node is
  # right here. Same choice as hermes/cron-jobs.sh.
  field() {
    printf '%s' "$2" | node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        try { console.log(Number(JSON.parse(raw)[process.argv[1]] ?? 0)); }
        catch { console.log(0); }
      });' "$1"
  }

  registered="$(field count "$(fin auth users)")"
  invites="$(field count "$(fin auth invites)")"

  if (( registered == 0 && invites == 0 )); then
    red "Nobody can get in: TALLY_ACCESS_CODE is empty, no invite was minted and"
    red "no one is registered yet."
    echo
    echo "Pick one — the invite is the recommended way:"
    echo "    make invite LABEL=\"Geovane\"      # single use, expires, prints once"
    echo "    openssl rand -base64 24           # or a shared TALLY_ACCESS_CODE in .env"
    echo
    echo "See docs/setup.md."
    exit 1
  fi

  yellow "TALLY_ACCESS_CODE is empty: this install runs on invites only."
  echo   "  ${registered} person(s) registered, ${invites} invite(s) on record."
  echo   "  Nothing to do — that is the intended end state (no standing secret)."
  echo   "  One more person joins with: make invite LABEL=\"<nome>\""
fi

green "Bootstrap complete."
