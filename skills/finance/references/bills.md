# Credit-card statements (faturas)

`balance` reports `month_bill_fmt`, which is what was spent on the card inside
the current **calendar month**. That is not the bill. A purchase on 28/07 on a
card that closes on the 25th is billed in **August**, and paying the July bill
will not settle it.

`bill.ts` computes the real cycle from `accounts.closing_day` and
`accounts.due_day`. Use it whenever the user says *fatura*, *fechamento*,
*vencimento*, *"quanto devo no cartão"* — and never recompute a cycle yourself.

    node bill.ts --db <path> --user-id <users.id> [--account <nome>]
                 [--statement <open|last|next|YYYY-MM>] [--all] [--json]

`--user-id` is the internal `users.id`, not a Telegram id. Without `--json` the
command prints only the Portuguese text; with it, the full `{"ok": true, …}`
envelope. Failures always print `{"ok": false, "error": "…"}` and exit 1.

## The two conventions

**A purchase made on the closing day goes to the next statement.** The cycle runs
from the previous closing date (inclusive) to the day *before* this closing date
(inclusive). `closing_date` is therefore already the first day of the following
cycle. This is what Brazilian issuers do, and it is the conservative reading:
what you buy today never lands on a bill that is closing right now.

**A statement is named after the month it closes in.** A card closing on the 25th
has its "fatura de 08/2026" covering 25/07 to 24/08. The due date falls in that
same month when `due_day > closing_day` (closes on the 5th, pays on the 20th),
and in the month after when `due_day <= closing_day` (closes on the 25th, pays on
the 5th of the next month).

`closing_day = 31` is clamped to the last day of each month, the same way
instalments are: February closes on the 28th (29th in a leap year), April on the
30th. The February statement still *starts* on 31/01, so no day is ever lost
between two statements.

## Selecting a statement

| `--statement` | What it means |
|---|---|
| `open` (default) | The one today's purchases fall on — still accumulating |
| `last` | The one that closed most recently; usually the bill being paid now |
| `next` | The one that comes due first from today on |
| `YYYY-MM` | Named explicitly, by **closing** month |

`aberta`, `fechada`/`anterior` and `proxima` are accepted as well.

## Fields worth reading

| Field | What it is |
|---|---|
| `text` | The whole statement in Portuguese, ready for Telegram |
| `statement.start` / `.end` | The dates covered |
| `statement.closing_date` / `.due_date` | When it closes and when it is due |
| `statement.has_closing_day` | `false` = the card has no closing day; see below |
| `total_fmt` / `count` | The bill and how many purchases it has |
| `by_category[]` | Rolled up to the root category, with `pct` |
| `installments[]` | What is parcelado on this bill, each with `n/total` |
| `limit.used_pct` / `.remaining_fmt` | How much of the limit this bill eats |
| `previous.change_pct` / `.difference_fmt` | Against the previous statement |

Send `text` as it came. Do not rewrite or summarise it — rewriting only
introduces number errors.

## Cards with no closing day

When `closing_day` is not set, the cycle falls back to the calendar month and
`has_closing_day` comes back `false`. Say so instead of pretending it is the real
bill:

> ⚠️ Esse cartão não tem fechamento cadastrado, então usei o mês civil.
> Me diz o dia de fechamento e o de vencimento que eu cadastro.

Then record it — `closing` and `due` are options of `account add`.

## Every card at once

`--all` lists each card with its open statement total and due date, soonest due
first. That is the answer to *"quanto devo nos cartões?"*:

> 💳 R$ 2.361,70 no Nubank (fecha 25/08, vence 05/09) e R$ 420,00 no Itaú
> (vence 20/08). Total: R$ 2.781,70.

## What is not on a statement

Only `expense` rows on that card, inside the cycle. Paying the bill is a
`transfer` to the card ([categories.md](categories.md)), so it never cancels out
the purchases it pays for, and income on a card is not a purchase.
