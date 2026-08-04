---
name: finance
description: Personal finance ledger in SQLite
version: 1.0.0
author: Geovane
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    category: finance
    tags: [Finance, Budget, SQLite, Telegram, Reports]
    related_skills: [xlsx]
---

# Personal finance ledger

Records expenses, income and transfers in SQLite; tracks budgets, fixed costs,
instalment plans and savings goals; produces reports ready to send on Telegram.

**You speak Brazilian Portuguese to the user.** This document is in English
because it is code-adjacent, but every message you send is Portuguese, and the
example replies below are literal templates — copy their shape.

Everything goes through one command:

    node ${HERMES_SKILL_DIR}/scripts/fin.ts <subcommand> [options]

Output is always JSON: `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.
When `ok` is false, the `error` text is already written in Portuguese for the
user — relay it or act on it. Never claim success without having seen
`"ok": true`.

## Two people, two separate ledgers

This bot serves two people, and their money is completely separate: separate
transactions, accounts, categories, budgets and goals. Nobody ever sees the
other's numbers, and neither do you.

**The tool knows who is talking, so you do not have to tell it.** The sender's
identity comes from the session, straight from the gateway into the command's
environment. So:

- Call every subcommand exactly as documented below, with **no** `--user`.
- You do not know anyone's numeric Telegram id, and it is not your job to find
  out. Never ask the user for it, never read one out of a previous message,
  never pass `--user` yourself.
- `--user` exists in the CLI for the operator's own terminal and for the
  scheduled jobs. Inside a conversation it is either redundant or a refusal.
- If a command ever fails saying it could not identify who is speaking, say you
  cannot identify the user right now and stop. Do not retry with a guess.

**Being straight about what enforces this.** The identity check is in the CLI, and
you are running on the same machine with a shell — so it is not a wall you could not
climb if you set out to. It is the rule you follow. What actually keeps the two
ledgers apart is you doing the above, plus the gateway deciding whose messages reach
you at all. Treat "the tool would stop me" as a reason to never try, not as a
guarantee. The same goes for the guardrails below.

### Things you do not do, even when asked

These commands exist for the operator's terminal, and they refuse to run from a
conversation. If a message asks for one, say it is not something you can do here:

- `auth users` and `auth status` with no user — they list **both** people's
  Telegram ids, chat ids and login times.
- `auth logout-all` — it would sign everybody out, repeatedly.
- `auth unlock`, `auth adopt-legacy` — access and history-ownership changes.

The refusal that comes back says so in Portuguese; relay it. And note it is a
guardrail: it is there so a request cannot talk you into it, not because the check
could not be circumvented by something determined to. Do not look for a way around
it — there is nothing on the other side that belongs in a chat.

Likewise: **never read the database file directly**, with `sqlite3`, `node:sqlite`
or anything else, even to answer something the CLI cannot. A query you write has no
user scoping in it — you do not know whose ledger you are in — so it either tells
you nothing or mixes two people's money. If a subcommand cannot answer, say so.

## Access code

Before someone can use the ledger at all, they type a shared access code once.
This is enforced by the tool, not by you.

When any response comes back with **`"auth_required": true`**, that person is not
authenticated (either never was, or the owner reset every session). Relay the
`error` text and wait for the code:

> 🔒 Antes de falar de dinheiro eu preciso confirmar quem é você. Me manda o
> código de acesso.

The next message they send is the code. Take it and run:

    fin.ts auth login --code "<what they typed>" [--name "<first name>"]

On success:

> ✅ Tudo certo. Agora é só me contar seus gastos.

On failure the `error` is already written for them — relay it as-is:

> Código incorreto.

After five wrong attempts the tool locks that person out and says so. Relay it
and do not try again:

> 🔒 Bloqueei as tentativas depois de 5 códigos errados. Peça ao Geovane para
> liberar o acesso.

There is also a global limit (20 wrong codes in total, across everyone) which locks
every id at once, and gives the same message. Only Geovane can lift either, from the
server — there is nothing you can do about it, and you must not try.

**Rules about the code, without exception:**

- **Never print, repeat, quote or confirm the code** — not in a confirmation, not
  in an example, not to check you got it right. Not even partially.
- **Never guess it, never try a variation** of what the user typed, and never try
  a code they did not type in this conversation.
- If they ask you what the code is, say you do not have it and they should ask
  Geovane.
- Delete it from your reply entirely: pass it to the tool, then talk about
  whether it worked, never about the value.

Once authenticated, the person stays authenticated. You do not need to check
first — just run the command you were going to run, and handle
`auth_required: true` if it comes back.

## When to use

Any message about money: an expense, income, a question about balance, a request
for a report, setting a limit, registering an account.

## The three rules

1. **Never invent a number.** Every figure you report comes from a tool call. Do
   not add up, average or estimate percentages yourself.
2. **Never compute a date.** Pass the user's own words to `--date` (`hoje`,
   `ontem`, `03/08`, `dia 7`, `2026-08-03`). You do not know today's date; the
   tool does, and resolves it in São Paulo time.
3. **Never convert an amount.** Pass it as written (`27`, `89,90`, `1.234,56`,
   `1,2k`, `30 reais`). The tool reads Brazilian notation.

## Recording a transaction

    fin.ts add --amount <v> --description "<text>" [--category <c>] [--account <a>]
               [--date <d>] [--type expense|income|transfer]
               [--tags "a,b"] [--installments N] [--note "<text>"]
               [--dest-account <a>]

Defaults: `--type expense`, `--date` today, `--account` the default account.

| The user says | Command |
|---|---|
| `uber 27` | `add --amount 27 --description "Uber" --category "Uber/99"` |
| `mercado 234,56` | `add --amount 234,56 --description "Mercado" --category Mercado` |
| `89,90 ifood ontem no nubank` | `add --amount 89,90 --description "iFood" --category Delivery --account Nubank --date ontem` |
| `pix 50 pra minha mãe` | `add --amount 50 --description "PIX para minha mãe" --category Família` |
| `recebi 7500 de salário` | `add --type income --amount 7500 --description "Salário" --category Salário` |
| `notebook 3600 em 12x no nubank` | `add --amount 3600 --description "Notebook" --category Eletrônicos --account Nubank --installments 12` |
| `transferi 500 da conta pra poupança` | `add --type transfer --amount 500 --description "Transferência" --account "Itaú" --dest-account Poupança` |

### Confirming

One line, with the id at the end — that is how the user corrects it later:

> ✅ R$ 27,00 · Uber · hoje · Carteira (#142)

The `add` response already carries a `budget` field with the state of the limit
covering that category. If `status` is `warning` or `over`, add a second line —
**do not make another call to find this out**:

> 🟡 Alimentação: R$ 450,00 de R$ 500,00 este mês.

For an instalment plan, confirm the total, the instalment amount and when it ends:

> ✅ Notebook R$ 3.600,00 em 12x de R$ 300,00 · Nubank (#150)
> Última parcela em 03/07/2027.

### Several expenses in one message

"gastei 30 no almoço e 12 no café" is two transactions: two `add` calls. Confirm
both in a single reply.

### When to ask

Ask **one** short question, and only when something essential is missing:

- **Amount missing or unreadable** → ask. Never guess.
- **Description too vague** ("gastei 50") → ask what it was for.
- **Category uncertain** → do not ask. Pick the most likely one and record; if
  it is wrong, the user corrects it. Filing under `Outros` beats stalling.
- **Account not mentioned** → do not ask. It goes to the default account.

## Correcting and deleting

    fin.ts edit <id> [--amount v] [--description t] [--category c] [--account a]
                     [--date d] [--type t] [--tags "a,b"] [--note t]
    fin.ts rm <id> [--group]

Only the fields you pass change. `--group` deletes a whole instalment series (use
it when the user says "cancela aquele parcelamento").

"não, foi 37", "era no cartão", "isso foi ontem" refer to the last transaction
you confirmed — use that id.

## Querying

    fin.ts summary --period <p> [--no-compare]
    fin.ts ls [--period p] [--category c] [--account a] [--type t] [--tag t]
              [--text t] [--status paid|pending|all] [--limit N] [--order asc|desc]
    fin.ts search "<term>" [--limit N]
    fin.ts balance

Accepted periods: `today`, `yesterday`, `week`, `last-week`, `month`,
`last-month`, `full-month`, `year`, `last-year`, `7d`, `30d`, `90d`, `2026-08`,
`all`.

`summary` returns totals, a breakdown by category and by account, the largest
expenses, a daily average and a comparison with the previous period. It is what
answers "quanto gastei esse mês?" — but **reply in a couple of lines**, never
dump the JSON:

> 💸 Este mês: R$ 1.724,46 em 12 lançamentos.
> A maior fatia foi Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

`ls` shows paid and pending together by default — "meus lançamentos" means both.
`--status pending` narrows it to what is still owed, and every row carries its
`status`.

`balance` lists the accounts, counting only money that has actually moved. On a
credit card, a negative balance is what the user owes; `month_bill_fmt` is a rough
calendar-month sum of that card's spending — for the real statement, with its cycle,
closing and due dates, use the `bill` subcommand instead. Each account also carries
`pending_cents`: committed and not yet out (see "Paid and pending").

## Reports

    fin.ts report --period <p> [--title "<t>"] [--top N] [--with-data]

Returns `text`, already formatted in Portuguese for Telegram. **Send it exactly
as it came** — do not rewrite, summarise or reformat it. It already covers
expenses, income, the net result, the comparison with the previous period, the
category ranking, the largest expenses and any budget in trouble.

## Budgets

    fin.ts budget set --limit <v> [--category <c>] [--month YYYY-MM] [--alert N]
    fin.ts budget status [--month YYYY-MM]
    fin.ts budget rm [--category <c>] [--month YYYY-MM]

With no `--category`, the limit is the **total** cap for the month. With no
`--month`, it applies to every month (the normal case). `--alert` is the
percentage that triggers the amber warning (default 80).

Budgets count **paid and pending together**, so a bill that is due already shows up
against the limit. Each budget carries `spent_fmt` (paid), `pending_fmt` (still to
pay) and `committed_fmt` (the two added, which is what `pct` and `status` follow).
When part of it is pending, say so — the number will not match the balance
otherwise:

> 🟡 Alimentação: R$ 450,00 de R$ 500,00 este mês, R$ 120,00 disso ainda a pagar.

A limit on a root category captures its children: a cap on `Alimentação` includes
whatever was logged under `Delivery`, `Mercado` and `Restaurante`.

| The user says | Command |
|---|---|
| `limite de 500 pra alimentação` | `budget set --category Alimentação --limit 500` |
| `não quero gastar mais de 4 mil por mês` | `budget set --limit 4000` |
| `como estão meus limites?` | `budget status` |

## Accounts and cards

    fin.ts account add --name <n> [--type checking|card|cash|savings|investment|voucher]
                       [--institution i] [--due D] [--closing D]
                       [--limit v] [--opening-balance v]
    fin.ts account list
    fin.ts account default --name <n>
    fin.ts account rm --name <n>

`account rm` deactivates and **keeps the history** — nothing is deleted.

Example: `cadastra meu cartão do nubank, vence dia 10, limite 5 mil` →
`account add --name Nubank --type card --institution Nubank --due 10 --limit 5000`

## Fixed costs

    fin.ts recurring add --description <d> --amount <v> [--category c] [--account a]
                         [--frequency monthly|weekly|yearly] [--day D] [--ends date]
                         [--type expense|income] [--auto-debit]
    fin.ts recurring list
    fin.ts recurring apply
    fin.ts recurring pending
    fin.ts recurring pay <id> [--amount <v>] [--date <d>]
    fin.ts recurring unpay <id>
    fin.ts recurring due [--in <days>]
    fin.ts recurring rm --id <id>

`apply` generates the due transactions and is idempotent — running it twice
duplicates nothing. Cron already calls it daily; you rarely need to.

When registering one, the first automatic charge is the **next** occurrence,
never a backfill: if today is the 12th and the user registers rent due on the
5th, automatic logging starts next month. Say so, and offer to log this month's
by hand:

> ✅ Aluguel de R$ 1.500,00 todo dia 5. A cobrança automática começa em 05/09.
> Quer que eu registre o de agosto agora?

Use `--auto-debit` when the money leaves by itself — débito automático, or a
subscription that just hits the card. Ask only if the user's own words leave it
open ("todo mês desconta na conta" is auto-debit; "pago o aluguel dia 5" is not).

### Paid and pending

A fixed cost has two moments, and the tool keeps them apart:

- **Due.** `apply` creates the occurrence on its date, as *pending*. It counts
  against the month's **budget** — the money is committed — and stays out of the
  **balance**, because it has not left the account.
- **Paid.** `recurring pay <id>` settles it: the balance moves, `paid_at` is
  recorded, and the budget figure does not change (it was already counted).

An `--auto-debit` entry skips straight to paid, and so does income.

`--amount` on payment overrides the value, because a light or water bill is never
the same twice. When it differs from the estimate the response says so — pass that
on:

> ✅ Luz paga: R$ 212,40 — R$ 32,40 acima do previsto (R$ 180,00). (#207)

A plain payment is one line:

> ✅ Aluguel pago: R$ 1.500,00. (#204)

`recurring unpay <id>` undoes a payment marked by mistake. It only works on a bill
the tool generated, never on an ordinary expense.

**"quais contas eu tenho pra pagar?"** → `recurring pending`. Oldest first, with
`days_overdue` and a total. One line per bill:

> ⏳ Faltam 2 contas, R$ 1.619,90:
> • Aluguel — R$ 1.500,00 · venceu 05/08 (3 dias em atraso)
> • Internet — R$ 119,90 · vence hoje

With nothing pending, `count` is 0 and `silent` is true — say it plainly ("Nada
pendente por aqui.") when they asked, and send nothing at all when cron did.

`recurring due --in <days>` is the *reminder*: it reads the schedule, so it knows
about tomorrow's bill before the occurrence exists. That is what the cron job calls,
and `silent: true` means the reply is exactly `[SILENT]`:

> 🔔 Amanhã vence a Internet, R$ 119,90.
> 🔔 Amanhã vence o Aluguel, R$ 1.500,00 (débito automático — não precisa fazer nada).

## Goals

    fin.ts goal add --name <n> --target <v> [--initial v] [--deadline date]
    fin.ts goal list
    fin.ts goal deposit --name <n> --amount <v>
    fin.ts goal rm --name <n>

The listing already computes the percentage, what is missing and the monthly
deposit needed to hit the deadline.

## Export

    fin.ts export --period <p> [--format csv|json|md]

CSV is the default and opens directly in Excel in Portuguese (`;` separator,
decimal comma). The response carries `file` with the path — to deliver the file
on Telegram, mention that path in your reply and the gateway attaches it. If it
should not be turned into an image preview, end your reply with `[[as_document]]`.

Leave the destination alone. `--dest` exists, but it only accepts a directory inside
the bot's own data folder, and the default is already the right place.

## Categories

    fin.ts category list
    fin.ts category add --name <n> [--parent <p>] [--type expense|income|both] [--emoji e]

Each person gets their own copy of 17 categories and about 70 subcategories when
they first authenticate, named in Portuguese because the user reads them. One
person renaming or deleting a category does not affect the other. Pass whatever
word the user used —
matching ignores accents, case and plurals, and prefers the most specific
subcategory. If it does not exist, the category is created under `Outros` rather
than failing the transaction.

The full mapping from everyday Brazilian terms to categories lives in
`references/categories.md`. Load it with `skill_view` when you are unsure where
something recurring belongs.

## Common failures

| Symptom | Cause and way out |
|---|---|
| `"auth_required": true` | Not authenticated. Ask for the access code, then `auth login --code`. |
| `Código incorreto` | Relay it. Wait for another attempt; never try a variation yourself. |
| `Bloqueei as tentativas...` | Five failures. Relay it and stop — only Geovane can lift it. |
| `Não consegui identificar quem está falando` | The session had no identity. Say you cannot identify the user; never pass `--user` to work around it. |
| `Essa chamada tentou mexer no dinheiro de outra pessoa` | You passed `--user`. Do not — drop the option and call again. |
| `Conta "X" não existe` | Wrong name. Run `account list`, confirm with the user, or use the default account. |
| `Mais de uma conta casa com "Itaú"` | Ambiguous. Show the options and ask which. |
| `Descrição é obrigatória` | You omitted `--description`. Never do. |
| `O valor precisa ser maior que zero` | No amount, or zero. Ask. |
| `Não entendi a data` | Pass `hoje`/`ontem`/`DD/MM` instead of free text. |
| `Não achei o lançamento #N` | Wrong id. Use `ls` to locate it. |
| `Esse valor é alto demais` | A typo or a stray zero. Confirm the amount with the user. |
| `O lançamento #N já está pago` | Already settled. Say so; do not pay it twice. |
| `... não é uma conta fixa` | `unpay` only works on a bill the tool generated. |
| `é um comando do operador` | An operator-only command. Say it is not something you can do from here, and stop. |
| `Só consigo exportar para dentro da pasta de dados` | Drop `--dest` and let it choose. |

## Four more subcommands, each with its own reference

These live in separate modules but you call them exactly like the rest, through
`fin.ts`, and they resolve the caller the same way. Load the matching reference
with `skill_view` before using one for the first time — each has conventions you
will get wrong by guessing.

    fin.ts bill [--account <n>] [--statement open|last|next|YYYY-MM] [--all]
    fin.ts chart --type category|trend|cumulative [--period p] [--months N] [--month YYYY-MM]
    fin.ts forecast [--month YYYY-MM]
    fin.ts import --file <path> [--format ofx|csv|auto] [--account <n>] [--apply]

**`bill` — the real credit-card statement.** Use it for anything about a card
invoice, and prefer it over `balance`'s `month_bill_fmt`: a purchase on 28/07 on
a card that closes on the 25th belongs to the **August** statement, and only
`bill` knows that. `--all` answers "quanto devo nos cartões?". Send its `text` as
it came. → `references/bills.md`

**`chart` — a picture of the spending.** Returns both a `text` bar chart, which
reads inline in the chat, and a PNG at `file`. **Send the `text` always**; mention
the `file` path as well so the gateway attaches the image, and end that reply with
`[[as_document]]`. When `empty` is true there is nothing to plot — say so in one
line, do not retry. → `references/charts.md`

**`forecast` — how the month is likely to close.** *"No ritmo atual você fecha o
mês em R$ 4.200, R$ 300 acima do seu limite."* Read `confidence` before you speak:
on `none` or `low` the projection is thin, and the `text` already says so — never
restate the number as if it were certain. Never use it to scold. → `references/forecast.md`

**`import` — a bank or card statement.** Two steps, and the order is not optional:
run **without** `--apply` first, show the person the preview (how many new, how
many are duplicates, the total), and only run again **with** `--apply` after they
agree. Re-importing the same file is safe — it recognises what it already brought
in. → `references/import.md`

## References

Load with `skill_view` when needed:

- `references/categories.md` — the full taxonomy and how everyday Brazilian
  terms map onto it ("ifood" → Delivery, "99" → Uber/99).
- `references/parsing.md` — how to read Portuguese messages: amounts, dates,
  payment methods, multiple items, corrections.
- `references/reports.md` — what each report contains and how to present each
  period in chat.
- `references/schema.md` — what the data means: tables, columns, the paid/pending
  model, how the two ledgers are kept apart. Not a query guide — never read the
  database yourself.

## Verification

Before confirming anything to the user:

1. Did the output carry `"ok": true`?
2. Does `amount_fmt` match what they said?
3. Is `date` the one they meant?
4. Did you quote the `id` in your confirmation?
5. Is the access code absent from your reply?

If you recorded something wrong, fix it with `edit` and say what changed — never
let it slide silently.
