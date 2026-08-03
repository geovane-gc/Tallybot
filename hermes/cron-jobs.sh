#!/usr/bin/env bash
#
# Creates the scheduled jobs: periodic reports, budget checks and applying fixed
# costs. Idempotent.
#
#   make cron-install
#
# Times are America/Sao_Paulo, set through TZ in the compose file.
#
# The prompts themselves are Portuguese on purpose: they are instructions the
# agent follows to produce a message for the user, and they carry the reply
# templates.
#
set -euo pipefail

cd "$(dirname "$0")/.."

FIN="node /opt/data/skills/finance/scripts/fin.ts"

if [[ -z "$(docker compose ps -q hermes 2>/dev/null)" ]]; then
  echo "The container is not running. Start it with 'make up' first." >&2
  exit 1
fi

herm() { docker compose exec -T hermes hermes "$@"; }

# `cron remove` takes the id or the name as a POSITIONAL argument — there is no
# --name flag here. `--skill finance` keeps the reference loaded when the job
# fires, saving a skill_view turn.
recreate() {
  local name="$1"; shift
  local schedule="$1"; shift
  local prompt="$1"; shift

  herm cron remove "$name" >/dev/null 2>&1 || true
  herm cron create "$schedule" "$prompt" \
    --name "$name" --deliver telegram --skill finance "$@"
  echo "  ✓ $name  ($schedule)"
}

echo "Creating scheduled jobs..."

# At 06:00, before any report, so the day's fixed costs are already logged when
# the digest runs.
recreate "tally-recurring" "0 6 * * *" \
"Aplique as despesas fixas vencidas rodando:

  $FIN recurring apply

Se o campo 'silent' vier true (nada foi gerado), responda apenas [SILENT].
Caso contrário, avise em uma linha por lançamento o que foi registrado
automaticamente, no formato: '🔁 Lancei <descrição> de <valor> (<data>)'."

recreate "tally-alerts" "0 9,15,21 * * *" \
"Verifique os limites de orçamento rodando:

  $FIN alerts --mark

Se 'silent' vier true, responda APENAS [SILENT] e mais nada.
Se houver alertas, repasse o campo 'message' de cada um, uma por linha, sem
acrescentar comentário, conselho ou julgamento. Só o número."

recreate "tally-daily" "0 21 * * *" \
"Gere o resumo do dia rodando:

  $FIN report --period today --top 3

Se o texto retornado disser que não houve lançamento no período, responda
APENAS [SILENT] — não vale notificar para dizer que não houve gasto.
Caso contrário, envie o campo 'text' exatamente como veio, sem reescrever."

recreate "tally-weekly" "0 20 * * 0" \
"Gere o fechamento da semana rodando:

  $FIN report --period week --title 'Sua semana'

Envie o campo 'text' como veio. Depois acrescente UMA frase curta comparando
com a semana anterior, usando o número que já está no relatório. Sem conselho e
sem julgamento sobre os gastos."

recreate "tally-monthly" "0 9 1 * *" \
"Hoje é dia 1º: gere o fechamento do mês que terminou.

  $FIN report --period last-month --with-data

Envie o campo 'text' como veio. Em seguida, exporte os lançamentos do mês
fechado para planilha:

  $FIN export --period last-month --format csv

Cite o caminho do arquivo retornado no campo 'file' na sua resposta, para que
ele seja anexado, e termine a mensagem com [[as_document]]."

echo
echo "Jobs created. Check them with 'make cron-list'."
echo "To fire one now, without waiting for its schedule:"
echo "  docker compose exec hermes hermes cron run tally-daily"
