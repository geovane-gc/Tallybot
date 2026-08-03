#!/usr/bin/env bash
#
# Prepara ./data e valida a configuração antes de subir o container.
# Idempotente.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DATA="$ROOT/data"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  yellow "Criei .env a partir de .env.example."
  red    "Preencha OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN e TELEGRAM_ALLOWED_USERS."
  echo   "Instruções: docs/setup.md"
  exit 1
fi

# UID/GID do host, para que os arquivos criados em data/ fiquem editáveis fora
# do container.
if grep -qE '^HERMES_UID=$' "$ROOT/.env"; then
  sed -i.bak "s/^HERMES_UID=$/HERMES_UID=$(id -u)/" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  green "HERMES_UID=$(id -u) gravado no .env"
fi
if grep -qE '^HERMES_GID=$' "$ROOT/.env"; then
  sed -i.bak "s/^HERMES_GID=$/HERMES_GID=$(id -g)/" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  green "HERMES_GID=$(id -g) gravado no .env"
fi

missing=()
for var in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
  value="$(grep -E "^${var}=" "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [[ -z "$value" ]] && missing+=("$var")
done

if (( ${#missing[@]} > 0 )); then
  red "Faltam variáveis no .env: ${missing[*]}"
  echo "Veja docs/setup.md."
  exit 1
fi

mkdir -p "$DATA"/{skills,financas,logs}

# O Hermes lê os segredos de /opt/data/.env dentro do container.
cp "$ROOT/.env" "$DATA/.env"
chmod 600 "$DATA/.env"

# Sobrescreve a cada bootstrap para que hermes/ seja a fonte da verdade e as
# mudanças fiquem versionadas.
cp "$ROOT/hermes/config.yaml" "$DATA/config.yaml"
cp "$ROOT/hermes/SOUL.md"     "$DATA/SOUL.md"
green "config.yaml e SOUL.md sincronizados de hermes/ para data/"

node "$ROOT/skills/financas/scripts/fin.ts" \
  --db "$DATA/financas/financas.db" init >/dev/null
green "Banco pronto em data/financas/financas.db"

green "Bootstrap concluído."
