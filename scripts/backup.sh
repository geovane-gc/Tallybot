#!/usr/bin/env bash
#
# Backup do banco financeiro.
#
# Usa a API de backup do SQLite em vez de copiar o arquivo: o container pode
# estar escrevendo durante a cópia e, em modo WAL, um `cp` capturaria estado
# inconsistente.
#
set -euo pipefail

cd "$(dirname "$0")/.."

DB="data/financas/financas.db"
DEST="backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$DB" ]]; then
  echo "Banco não encontrado em $DB." >&2
  exit 1
fi

mkdir -p "$DEST"
OUT="$DEST/financas-$STAMP.db"

# Caminhos por env, não por argumento: em `node -e`, process.argv não tem o
# caminho do script na posição 1, então o índice dos argumentos muda em relação
# a um arquivo normal — fonte fácil de erro silencioso.
ORIGEM="$DB" DESTINO="$OUT" node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
// Sem `readOnly`: em modo WAL, uma conexão somente-leitura precisa do arquivo
// -shm, que não existe quando ninguém tem o banco aberto — e ela não pode
// criá-lo, falhando com "unable to open database file". VACUUM INTO não altera
// a origem, e gera um destino íntegro e compactado mesmo com o container
// escrevendo em paralelo.
const db = new DatabaseSync(process.env.ORIGEM);
// Caminho como parâmetro, não interpolado: `VACUUM INTO ?` aceita bind, e assim
// não há escape de aspas para errar (aspas duplas o SQLite leria como nome de
// coluna, não como texto).
db.prepare("VACUUM INTO ?").run(process.env.DESTINO);
db.close();
'

gzip -f "$OUT"
echo "Backup: $OUT.gz"

# Mantém os 30 mais recentes. Loop em vez de `xargs -r`, que o BSD/macOS não tem.
ls -1t "$DEST"/financas-*.db.gz 2>/dev/null | tail -n +31 | while read -r old; do
  rm -f -- "$old"
done
