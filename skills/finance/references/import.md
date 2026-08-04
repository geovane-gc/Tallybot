# Importing a bank or card statement

`statement-import.ts` fills months of history from a file the person sends in the
chat. It reads OFX (every Brazilian bank exports it) and CSV (Nubank's account
and card exports, and most bank CSVs by luck of the sniffing).

Two phases, always in this order:

    # 1. preview — reads the file, writes nothing
    node statement-import.ts --db $DB --user-id 1 --file extrato.ofx

    # 2. apply — inserts only the new rows
    node statement-import.ts --db $DB --user-id 1 --file extrato.ofx --apply

Show the preview's `text` in the chat and wait for the person to confirm. Never
call `--apply` first: a statement can hold six months of transactions and there
is no undo beyond deleting them one by one.

`--user-id` is the internal `users.id`, **not** a Telegram id. The caller is
already authenticated by then.

## Options

| Option | Meaning |
|---|---|
| `--file PATH` | The statement. Required. |
| `--format ofx\|csv\|auto` | Default `auto`: the OFX header wins, then the extension. |
| `--account NAME` | Which account the rows belong to. Defaults to the person's default account. |
| `--sign auto\|debit-negative\|debit-positive` | CSV only, see below. |
| `--token T` | The token from the preview. Refuses to apply if the file changed. |
| `--apply` | Actually insert. Without it, preview only. |
| `--json` | Every row in the response, uncapped (the default caps at 40). |

Output follows the same contract as `fin.ts`: `{"ok": true, …}` and exit 0, or
`{"ok": false, "error": "<português>"}` and exit 1.

## What gets read

**OFX.** The format is SGML, not XML: `<TRNAMT>-45.90` usually never closes, and
the file is often cp1252 rather than UTF-8. Both are handled — reading cp1252 as
UTF-8 is what turns "Alimentação" into mojibake and there is no fixing it after
it lands in the ledger. Per transaction: `DTPOSTED` (only the calendar day
matters), `TRNAMT`, `MEMO` or `NAME` as the description, `FITID`, `TRNTYPE`.
Credit-card statements (`CREDITCARDMSGSRSV1`) are read the same way as bank
accounts.

**CSV.** The header is sniffed rather than assumed: `,`, `;` or tab as the
delimiter, columns in any order, a UTF-8 BOM tolerated, `1.234,56` and `1234.56`
both accepted, `DD/MM/YYYY` and ISO dates both accepted. A `Saldo`/`Balance`
column is never mistaken for the amount. Separate `Débito`/`Crédito` columns work
too. A missing required column fails with a Portuguese error that names the
column and echoes the header it read, instead of importing garbage.

**Sign.** Money out is negative — that is the rule for OFX and for almost every
CSV. Nubank's *card* export is the exception: it lists charges as positive
numbers, and its English `date,title,amount` header is the tell, so that shape
switches to `debit-positive` automatically. Anything else can be forced with
`--sign`. When a CSV has no negative line at all the preview says so in
Portuguese instead of guessing, because getting this backwards inverts a whole
month.

A negative amount becomes an `expense` and a positive one an `income`. A salary
credit or a refund is never imported as spending.

## Deduplication

Re-importing the same statement, or two statements that overlap, must not
duplicate anything. There is no column in the schema for an external id, so the
identity of an imported row lives in `note`:

    [imp:fitid:<16 hex>][imp:hash:<16 hex>]

- **`fitid`** is present only when the file carried a bank-issued id
  (OFX `FITID`, Nubank's `Identificador`). It is
  `sha256("v1|" + userId + "|" + acctId + "|" + fitid)`, truncated to 16 hex
  characters. The account id comes from the file, because a FITID is only unique
  within an account.
- **`hash`** is always present: a content fingerprint over
  `(userId, date, amountCents, type, normalisedDescription)`, same construction.

Both markers are written on every imported row. That is what lets the formats
recognise each other: a transaction imported from an OFX is still matched when
the same period arrives later as a CSV with no FITID at all, and the other way
round.

The rule, per row, in file order:

1. If its `fitid` marker is already in **this person's** ledger → duplicate. The
   bank's own identifier, so no heuristics involved.
2. If the same `fitid` appeared earlier in the same file → duplicate.
3. Otherwise the fingerprint decides, **by count**: the file's Nth row with a
   given fingerprint is a duplicate only while N is within the number of rows the
   ledger already holds for it.

Rule 3 is the honest answer to the genuinely ambiguous case. Two identical
coffees on the same day for the same amount are two coffees, not a duplicate, so
a boolean "does this exist?" check would silently swallow the second one. With
counting: the ledger holds 0, the file holds 2, both import. Re-import the same
file and the ledger holds 2 against the file's 2, so nothing imports. Send a file
with three of them and exactly one new row lands.

Only previously *imported* rows take part. A transaction typed into the chat has
no marker and is never treated as a duplicate of a statement line — "ifood" and
"IFD*IFOOD.COM AGENCIA DE REST" would not match anyway, and dropping a real
statement line to protect a guess is the worse error. If the person had already
typed an expense that later arrives in the statement, they will see it twice and
can delete one; the preview is where that gets noticed.

Nothing ever dedupes across the two people: the user id is inside both digests,
so one person's markers cannot match the other's even before the `user_id`
filter on every query.

### Description normalisation

The fingerprint runs on a normalised description, because the same purchase comes
back worded differently from one export to the next. What is stripped:

- accents, case, repeated whitespace;
- acquirer prefixes glued on with a star: `PAG*`, `MP*`, `PICPAY*`, `CIELO*`,
  `GETNET*`, `STONE*`, …;
- instalment counters: `PARCELA 03/12`, `PARC 3/12`, `PARCELA 3 DE 12`, a
  trailing `03/12`;
- card-network wording: `COMPRA COM CARTAO`, `COMPRA NO DEBITO`;
- terminal, NSU, authorisation, document and reference numbers: `TERM 0042`,
  `NSU 998877`, `AUT 12345`, `DOC 6789`, `CV 8899`;
- CPF and CNPJ, and any bare run of four or more digits (store codes, sequence
  numbers, years);
- leftover punctuation.

Kept: the merchant name, `PIX`, `TED`, `SAQUE`, and short numbers, which are
often part of the name ("99 Tecnologia"). If stripping empties the string the
accent-free original is used — an empty fingerprint would make every unnameable
line look like the same transaction.

The residual risk this leaves: two genuinely different transactions on the same
day, for the same amount, whose descriptions normalise to the same string, spread
across two overlapping statements. The second one would be read as the first.
OFX avoids it entirely by carrying a FITID.

## Preview and apply cannot disagree

Apply re-reads the file and re-derives every decision, rather than trusting a
payload that passed through a model. The preview's `token` is a digest of
everything the file determined — bytes, format, sign convention, and every parsed
row down to its guessed category — and apply refuses to run when a token is
supplied and does not match.

What the token deliberately does *not* cover is the ledger's own state. It may
legitimately change between the two calls (cron, the other person, the same
person typing an expense), and apply re-deciding against the ledger of the moment
is correct behaviour rather than drift. The token pins the file, not the world.

## Categorisation

Guessed from the description using the merchant knowledge in
`categories.md`, extended with the names that actually show up on a statement
("IFD*IFOOD.COM AGENCIA DE REST" rather than "ifood"). Only rules matching the
direction are considered, so "estorno" on a debit line does not become income.
The longest matching keyword wins, which is what makes "uber eats" a Delivery and
not a ride.

Every row carries a confidence, and the preview counts the `low` ones so the
person can fix them afterwards. When nothing matches, the row goes to `Outros`
with the bank's description intact: a wrong category silently corrupts every
future report, and nobody re-checks a number that merely looks plausible.

Import never *creates* a category. A statement is full of merchant strings and
letting it grow the tree would leave a taxonomy nobody asked for. If a guessed
category has been renamed or deleted, the row still lands — under `Outros`, or
with no category at all. Losing a transaction is worse than losing its category.

Imported rows get `source = 'import'`, which is how they are told apart from
typed ones.

## What is not covered

- **A card bill payment is imported as income**, because the sign says so. It
  should be a transfer from the account to the card (see `categories.md`), but
  a transfer needs a destination account that the file does not name. Those rows
  come back with a Portuguese warning and low confidence; fix them with
  `fin.ts edit` after importing.
- Same for **withdrawals** and **investment transfers**: flagged, not converted.
- **Instalments** are imported as the single charge the statement shows, without
  filling `installment_num`/`installment_total` — the statement line is one real
  charge, not a plan this bot created.
- **CNAB, QIF, PDF and XLSX** are not read. Ask for OFX; every bank has it.
- **Multi-account OFX** files (bank and card in one document) are read, but every
  row lands in the single account given by `--account`.
- Files above **8 MB** are refused rather than loaded into memory, and a path
  outside the data, home, temp or working directories is refused before being
  opened.
