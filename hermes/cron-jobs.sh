#!/usr/bin/env bash
#
# Creates the scheduled jobs — periodic reports, budget checks and applying fixed
# costs — one set per authenticated user, delivered to that user's own private
# chat with the bot.
#
#   make cron-install
#
# Why per user: Hermes resolves a cron job's destination from `--deliver`. A bare
# `--deliver telegram` goes to TELEGRAM_HOME_CHANNEL, which is a single chat and
# would send both people's reports to the same place. `--deliver telegram:<id>`
# targets one chat explicitly (cron/scheduler.py resolves the colon form and it
# beats the env var). For a Telegram private chat the chat id equals the user id.
#
# Idempotent: every `tally-*` job is removed and recreated, so re-running after a
# second person authenticates simply adds their jobs. Run it again whenever
# someone new joins.
#
# Times are America/Sao_Paulo, set through TZ in the compose file.
#
# The prompts themselves are Portuguese on purpose: they instruct the agent to
# produce a message for a person, and they carry the reply templates.
#
set -euo pipefail

cd "$(dirname "$0")/.."

FIN="node /opt/data/skills/finance/scripts/fin.ts"

if [[ -z "$(docker compose ps -q hermes 2>/dev/null)" ]]; then
  echo "The container is not running. Start it with 'make up' first." >&2
  exit 1
fi

herm() { docker compose exec -T hermes hermes "$@"; }

# --- who gets reports --------------------------------------------------------
# `auth users` lists everyone registered. We only schedule for users whose
# session is current: someone who has never authenticated has no data to report
# on, and after `logout-all` there is nobody to report to until they come back.
users_json="$(docker compose exec -T hermes node \
  /opt/data/skills/finance/scripts/fin.ts auth users 2>/dev/null || echo '{}')"

# Parsing in node rather than jq: jq is not installed in the Hermes image, and
# node is right there. Emits one "<telegram_user_id> <chat_id> <name>" per line.
# A while-read loop rather than `mapfile`: that is a bash 4 builtin and macOS
# still ships bash 3.2, where `make cron-install` would die with
# "mapfile: command not found".
targets=()
while IFS= read -r _line; do
  [ -n "$_line" ] && targets+=("$_line")
done < <(printf '%s' "$users_json" | node --input-type=module -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  if (!payload || payload.ok !== true) process.exit(0);
  for (const u of payload.users ?? []) {
    if (!u.authenticated || u.current === false) continue;
    const id = String(u.telegram_user_id ?? "").trim();
    if (!id) continue;
    // In a private chat the chat id is the user id; fall back to it when the
    // CLI does not report a chat id separately.
    const chat = String(u.telegram_chat_id ?? id).trim() || id;
    const name = String(u.display_name ?? "").replace(/\s+/g, " ").trim() || id;
    console.log(`${id} ${chat} ${name}`);
  }
});
')

if (( ${#targets[@]} == 0 )); then
  echo "No authenticated users yet, so there is nobody to send reports to." >&2
  echo >&2
  echo "Mint one invite per person on the host ('make invite LABEL=\"...\"') or use" >&2
  echo "the shared TALLY_ACCESS_CODE, have each of them message the bot and type" >&2
  echo "it, then run 'make cron-install' again." >&2
  exit 1
fi

# --- wipe and recreate -------------------------------------------------------
# `cron remove` takes the id or the name as a POSITIONAL argument — there is no
# --name flag here. Removing every tally-* job first is what makes re-running
# safe, and it also cleans up jobs left behind by a user who was removed.
echo "Removing existing tally-* jobs..."
existing="$(herm cron list 2>/dev/null | grep -oE 'tally-[A-Za-z0-9_-]+' | sort -u || true)"
for job in $existing; do
  herm cron remove "$job" >/dev/null 2>&1 || true
done

# `--skill finance` keeps the reference loaded when the job fires, saving a
# skill_view turn — which on the free tier is a request off the daily quota.
create() {
  local name="$1" schedule="$2" chat="$3" prompt="$4"
  herm cron create "$schedule" "$prompt" \
    --name "$name" --deliver "telegram:${chat}" --skill finance
  echo "  ✓ $name  ($schedule)"
}

for target in "${targets[@]}"; do
  read -r tg_id chat_id display_name <<<"$target"
  echo
  echo "Scheduling for ${display_name} (chat ${chat_id})..."

  # Every prompt passes --user explicitly: a cron run has no inbound Telegram
  # message, so the gateway binds no session identity and the CLI cannot infer
  # the caller on its own.

  # 06:00, ahead of any report, so the day's fixed costs are already logged when
  # the digest runs.
  create "tally-recurring-${tg_id}" "0 6 * * *" "$chat_id" \
"Aplique as despesas fixas vencidas deste usuário rodando:

  $FIN recurring apply --user ${tg_id}

Se o campo 'silent' vier true (nada foi gerado), responda apenas [SILENT].
Caso contrário, avise em uma linha por lançamento o que foi registrado
automaticamente, no formato: '🔁 Lancei <descrição> de <valor> (<data>)'."

  create "tally-alerts-${tg_id}" "0 9,15,21 * * *" "$chat_id" \
"Verifique os limites de orçamento deste usuário rodando:

  $FIN alerts --mark --user ${tg_id}

Se 'silent' vier true, responda APENAS [SILENT] e mais nada.
Se houver alertas, repasse o campo 'message' de cada um, uma por linha, sem
acrescentar comentário, conselho ou julgamento. Só o número."

  create "tally-daily-${tg_id}" "0 21 * * *" "$chat_id" \
"Gere o resumo do dia deste usuário rodando:

  $FIN report --period today --top 3 --user ${tg_id}

Se o texto retornado disser que não houve lançamento no período, responda
APENAS [SILENT] — não vale notificar para dizer que não houve gasto.
Caso contrário, envie o campo 'text' exatamente como veio, sem reescrever."

  create "tally-weekly-${tg_id}" "0 20 * * 0" "$chat_id" \
"Gere o fechamento da semana deste usuário rodando:

  $FIN report --period week --title 'Sua semana' --user ${tg_id}

Envie o campo 'text' como veio. Depois acrescente UMA frase curta comparando
com a semana anterior, usando o número que já está no relatório. Sem conselho e
sem julgamento sobre os gastos."

  # 09:00, um dia antes do vencimento. Le a agenda (`recurring due`), nao os
  # lançamentos: no dia anterior a ocorrência ainda não foi materializada. Quem
  # tem --auto-debit nunca fica pendente, então já sai naturalmente daqui.
  create "tally-due-${tg_id}" "0 9 * * *" "$chat_id" \
"Veja o que vence amanhã para este usuário:

  $FIN recurring due --in 1 --user ${tg_id}

Se 'silent' vier true, responda APENAS [SILENT].
Caso contrário, avise em uma linha por conta, no formato:
'⏳ <descrição> de <valor> vence amanhã (<data>)'.
Depois, se houver alguma conta já vencida e não paga, acrescente o resultado de:

  $FIN recurring pending --user ${tg_id}

numa linha por conta atrasada. Sem cobrança e sem julgamento — só o número e a
data."

  # Segunda-feira: a previsão só tem sentido com alguns dias de mês corrido, e
  # diariamente viraria ruído.
  create "tally-forecast-${tg_id}" "0 19 * * 1" "$chat_id" \
"Projete como o mês deste usuário deve fechar:

  $FIN forecast --user ${tg_id}

Se 'silent' vier true, responda APENAS [SILENT].
Caso contrário, envie o campo 'text' exatamente como veio. Se o campo
'confidence' for 'none' ou 'low', NÃO envie número nenhum como se fosse certeza —
o próprio texto já diz que os dados são poucos, e é isso que deve chegar."

  create "tally-monthly-${tg_id}" "0 9 1 * *" "$chat_id" \
"Hoje é dia 1º: gere o fechamento do mês que terminou para este usuário.

  $FIN report --period last-month --with-data --user ${tg_id}

Envie o campo 'text' como veio. Em seguida, exporte os lançamentos do mês
fechado para planilha:

  $FIN export --period last-month --format csv --user ${tg_id}

Cite o caminho do arquivo retornado no campo 'file' na sua resposta, para que
ele seja anexado, e termine a mensagem com [[as_document]]."
done

echo
echo "Done: 7 jobs for each of ${#targets[@]} user(s). Check them with 'make cron-list'."
echo "To fire one now, without waiting for its schedule:"
read -r first_id _ _ <<<"${targets[0]}"
echo "  docker compose exec hermes hermes cron run tally-daily-${first_id}"
