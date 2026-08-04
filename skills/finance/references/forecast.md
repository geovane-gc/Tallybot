# End-of-month forecast

    node forecast.ts --db PATH --user-id <users.id> [--month YYYY-MM] [--json]

Projects where the current month lands, and the same for every budget. It only
reads — it never writes a transaction, never advances a recurring entry and never
records an alert.

`--user-id` is the internal `users.id`, not a Telegram id. Inside the agent this
command is reached through `fin.ts`, which resolves identity first; the numbers
below are always one person's own.

Without `--json` it prints the ready-to-send Portuguese text. With `--json` it
prints `{"ok": true, ...}`. A failure is always JSON — `{"ok": false, "error":
"..."}` — with exit code 1.

## The four parts, and why they are separate

The projected total is the sum of four things the response keeps apart, so the
text can explain itself instead of handing over one number nobody can check:

| Field | What it is | Certain? |
|---|---|---|
| `spent_cents` | already in the ledger this month | yes |
| `fixed_pending_cents` | recurring expenses still to be posted this month | yes |
| `scheduled_cents` | expenses already recorded with a later date (instalments) | yes |
| `variable_estimate_cents` | daily rate × days left | **no** |

`certain_cents` is the first three added up, `estimated_cents` the last one, and
`certain_pct` the share of the projection that is not a guess. A fixed cost that
`recurring apply` already generated shows up in `spent` or `scheduled` and is
**not** counted again in `fixed_pending` — the check is per `(recurring_id, date)`.

## The daily rate

Only variable spending feeds it: anything with a `recurring_id` or an
`installment_total` is excluded, because it is already counted as its own part.

The rate is a blend of this month and the same person's previous months:

    rate = w × (this month so far) + (1 - w) × (previous months)
    w    = days elapsed / days in month

Early in the month the projection leans on history, late in the month on what is
actually happening. Up to three previous calendar months take part, weighted 3/2/1
from most to least recent; a month with no variable expense at all is skipped
rather than averaged in as a zero, and a month's day count starts at the person's
first transaction ever.

Weekend and weekday days are weighted separately when there is enough history
(at least one full month), so "6 days left" containing two Sundays is not treated
like six Mondays. Paydays are deliberately not modelled: the ledger has no
reliable salary date, and guessing one would move the number without evidence.

`rate.basis` says which model produced it:

| `basis` | Meaning |
|---|---|
| `blend` | this month plus previous months — the normal case |
| `current` | this month only (no usable history, at least 7 days elapsed) |
| `history` | previous months only (the month has not started) |
| `insufficient` | **no projection**: `variable_estimate_cents` is `null` |
| `closed` | a past month; the numbers are actuals, not a forecast |

## Honesty about the estimate

`confidence` is `none`, `low`, `medium` or `high`, with `confidence_label` in
Portuguese. When it is `none` there is genuinely nothing to project — say so, do
not fall back to a number. `rate.observed_days`, `rate.history_months` and
`certain_pct` are what that judgement is made of, and they are all in the
response if someone asks how the projection was built.

## Per budget

Each entry of `budgets[]` carries `projected_cents`, `overflow_cents`, `status`
(the projection's ok/warning/over) and `current_status` (where the money stands
today). The useful field is `crossing_day`: the day of the month the limit is
crossed at the current rate, or `null` if it is not crossed. `already_over` means
the limit went before any projection was involved.

## The text, and `silent`

`text` is Portuguese, one fact per line, no markdown table (Telegram does not
render them). **Send it as it came** — rewriting it only introduces number errors.

`silent` follows the same convention as `alerts`: `true` when there is nothing
worth saying — a closed month, no data to project from, or a projection sitting
inside every limit. For a scheduled run, reply exactly `[SILENT]` in that case.

## What it does not know

- Purchases still to be made on instalments: a card bought in three parts on the
  20th is invisible until it is recorded, so the projection is low for someone
  who does that often.
- One-off spending that has never happened before (a trip, a repair). The rate
  only knows the shape of an ordinary month.
- Income: the projection is about expenses. It does not say whether the month
  closes in the black.
