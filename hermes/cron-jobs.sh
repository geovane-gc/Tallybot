#!/usr/bin/env bash
#
# Cria os jobs agendados: relatórios periódicos, checagem de limites e
# aplicação das despesas fixas. Idempotente.
#
#   make cron-install
#
# Horários no fuso America/Sao_Paulo, definido via TZ no compose.
#
set -euo pipefail

cd "$(dirname "$0")/.."

FIN="node /opt/data/skills/financas/scripts/fin.ts"

if [[ -z "$(docker compose ps -q hermes 2>/dev/null)" ]]; then
  echo "O container não está rodando. Suba com 'make up' antes." >&2
  exit 1
fi

herm() { docker compose exec -T hermes hermes "$@"; }

# `cron remove` recebe id ou nome POSICIONAL — não existe flag --name aqui.
# `--skill financas` deixa a referência já carregada quando o job dispara,
# poupando um turno de skill_view.
recriar() {
  local nome="$1"; shift
  local agenda="$1"; shift
  local prompt="$1"; shift

  herm cron remove "$nome" >/dev/null 2>&1 || true
  herm cron create "$agenda" "$prompt" \
    --name "$nome" --deliver telegram --skill financas "$@"
  echo "  ✓ $nome  ($agenda)"
}

echo "Criando jobs agendados..."

# Às 6h, antes de qualquer relatório, para que as fixas do dia já estejam
# lançadas quando o resumo rodar.
recriar "financas-recorrentes" "0 6 * * *" \
"Aplique as despesas fixas vencidas rodando:

  $FIN recorrente aplicar

Se o campo 'silent' vier true (nada foi gerado), responda apenas [SILENT].
Caso contrário, avise em uma linha por lançamento o que foi registrado
automaticamente, no formato: '🔁 Lancei <descrição> de <valor> (<data>)'."

recriar "financas-alertas" "0 9,15,21 * * *" \
"Verifique os limites de orçamento rodando:

  $FIN alertas --marcar

Se 'silent' vier true, responda APENAS [SILENT] e mais nada.
Se houver alertas, repasse o campo 'mensagem' de cada um, uma por linha, sem
acrescentar comentário, conselho ou julgamento. Só o número."

recriar "financas-diario" "0 21 * * *" \
"Gere o resumo do dia rodando:

  $FIN relatorio --periodo hoje --top 3

Se o texto retornado disser que não houve lançamento no período, responda
APENAS [SILENT] — não vale notificar para dizer que não houve gasto.
Caso contrário, envie o campo 'texto' exatamente como veio, sem reescrever."

recriar "financas-semanal" "0 20 * * 0" \
"Gere o fechamento da semana rodando:

  $FIN relatorio --periodo semana --titulo 'Sua semana'

Envie o campo 'texto' como veio. Depois acrescente UMA frase curta comparando
com a semana anterior, usando o número que já está no relatório. Sem conselho e
sem julgamento sobre os gastos."

recriar "financas-mensal" "0 9 1 * *" \
"Hoje é dia 1º: gere o fechamento do mês que terminou.

  $FIN relatorio --periodo mes-passado --com-dados

Envie o campo 'texto' como veio. Em seguida, exporte os lançamentos do mês
fechado para planilha:

  $FIN export --periodo mes-passado --formato csv

Cite o caminho do arquivo retornado no campo 'arquivo' na sua resposta, para que
ele seja anexado, e termine a mensagem com [[as_document]]."

echo
echo "Jobs criados. Confira com 'make cron-list'."
echo "Para testar um agora, sem esperar o horário:"
echo "  docker compose exec hermes hermes cron run financas-diario"
