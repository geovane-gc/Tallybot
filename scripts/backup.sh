#!/usr/bin/env bash
#
# Backs up the ledger.
#
# Uses SQLite's own backup path rather than copying the file: the container may
# be writing mid-copy and, in WAL mode, a plain `cp` would capture inconsistent
# state.
#
set -euo pipefail

cd "$(dirname "$0")/.."

DB="data/finance/tally.db"
DEST="backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$DB" ]]; then
  echo "No database found at $DB." >&2
  exit 1
fi

mkdir -p "$DEST"
OUT="$DEST/tally-$STAMP.db"

# Paths through the environment, not as arguments: with `node -e`, process.argv
# has no script path at index 1, so argument indexes shift compared to a real
# file — an easy source of silent bugs.
SOURCE_DB="$DB" TARGET_DB="$OUT" node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
// No `readOnly`: in WAL mode a read-only connection needs the -shm file, which
// does not exist when nobody has the database open — and it is not allowed to
// create one, failing with "unable to open database file". VACUUM INTO does not
// touch the source, and produces an intact, compacted target even while the
// container writes.
const db = new DatabaseSync(process.env.SOURCE_DB);
// The path is bound, not interpolated: `VACUUM INTO ?` accepts a parameter, so
// there is no quote escaping to get wrong (SQLite would read double quotes as a
// column name rather than as text).
db.prepare("VACUUM INTO ?").run(process.env.TARGET_DB);
db.close();
'

gzip -f "$OUT"
echo "Backup: $OUT.gz"

# Keep the 30 most recent. A loop instead of `xargs -r`, which BSD/macOS lacks.
ls -1t "$DEST"/tally-*.db.gz 2>/dev/null | tail -n +31 | while read -r old; do
  rm -f -- "$old"
done
