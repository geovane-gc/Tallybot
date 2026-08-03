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
              [--text t] [--limit N] [--order asc|desc]
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

`balance` lists the accounts. On a credit card, a negative balance is what the
user owes; `month_bill_fmt` is the current month's spending on that card.

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
                         [--type expense|income]
    fin.ts recurring list
    fin.ts recurring apply
    fin.ts recurring rm --id <id>

`apply` generates the due transactions and is idempotent — running it twice
duplicates nothing. Cron already calls it daily; you rarely need to.

When registering one, the first automatic charge is the **next** occurrence,
never a backfill: if today is the 12th and the user registers rent due on the
5th, automatic logging starts next month. Say so, and offer to log this month's
by hand:

> ✅ Aluguel de R$ 1.500,00 todo dia 5. A cobrança automática começa em 05/09.
> Quer que eu registre o de agosto agora?

## Goals

    fin.ts goal add --name <n> --target <v> [--initial v] [--deadline date]
    fin.ts goal list
    fin.ts goal deposit --name <n> --amount <v>
    fin.ts goal rm --name <n>

The listing already computes the percentage, what is missing and the monthly
deposit needed to hit the deadline.

## Export

    fin.ts export --period <p> [--format csv|json|md] [--dest <dir>]

CSV is the default and opens directly in Excel in Portuguese (`;` separator,
decimal comma). The response carries `file` with the path — to deliver the file
on Telegram, mention that path in your reply and the gateway attaches it. If it
should not be turned into an image preview, end your reply with `[[as_document]]`.

## Categories

    fin.ts category list
    fin.ts category add --name <n> [--parent <p>] [--type expense|income|both] [--emoji e]

The database ships with 17 categories and about 70 subcategories, named in
Portuguese because the user reads them. Pass whatever word the user used —
matching ignores accents, case and plurals, and prefers the most specific
subcategory. If it does not exist, the category is created under `Outros` rather
than failing the transaction.

The full mapping from everyday Brazilian terms to categories lives in
`references/categories.md`. Load it with `skill_view` when you are unsure where
something recurring belongs.

## Common failures

| Symptom | Cause and way out |
|---|---|
| `Conta "X" não existe` | Wrong name. Run `account list`, confirm with the user, or use the default account. |
| `Mais de uma conta casa com "Itaú"` | Ambiguous. Show the options and ask which. |
| `Descrição é obrigatória` | You omitted `--description`. Never do. |
| `O valor precisa ser maior que zero` | No amount, or zero. Ask. |
| `Não entendi a data` | Pass `hoje`/`ontem`/`DD/MM` instead of free text. |
| `Não achei o lançamento #N` | Wrong id. Use `ls` to locate it. |

## References

Load with `skill_view` when needed:

- `references/categories.md` — the full taxonomy and how everyday Brazilian
  terms map onto it ("ifood" → Delivery, "99" → Uber/99).
- `references/parsing.md` — how to read Portuguese messages: amounts, dates,
  payment methods, multiple items, corrections.
- `references/reports.md` — what each report contains and how to present each
  period in chat.
- `references/schema.md` — the database schema, for queries the CLI does not
  cover.

## Verification

Before confirming anything to the user:

1. Did the output carry `"ok": true`?
2. Does `amount_fmt` match what they said?
3. Is `date` the one they meant?
4. Did you quote the `id` in your confirmation?

If you recorded something wrong, fix it with `edit` and say what changed — never
let it slide silently.
