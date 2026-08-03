# Reports and how to present them

## `report` — ready-made text

    fin.ts report --period <p> [--title "<t>"] [--top N] [--with-data]

The `text` field comes back already formatted in Portuguese for Telegram. **Send
it as it came.** Do not rewrite, summarise or add an introduction. Rewriting only
introduces number errors and burns context.

It contains, in order: the period · expenses · income · net result · comparison
with the previous period · category ranking with percentages · the five largest
expenses · any budget in warning or over.

`--top` controls how many categories make the ranking (default 8). For the daily
digest, `--top 3` reads better.

## `summary` — raw data

    fin.ts summary --period <p> [--no-compare]

Use this when the user asks something specific, not when they ask for "the
report". Useful fields:

| Field | What it is |
|---|---|
| `expenses_fmt` / `income_fmt` | Period totals |
| `net_fmt` | Income minus expenses |
| `daily_average_fmt` | Average spending per day in the period |
| `count` | Number of transactions |
| `by_category[]` | Ranking with `total_fmt` and `pct` |
| `by_account[]` | How much left each account |
| `top_expenses[]` | The ten largest, with description and date |
| `comparison.change_pct` | Percentage change against the previous period |

Answer in two or three lines, picking whatever addresses their question. Never
dump the whole structure.

**"quanto gastei esse mês?"**
> 💸 R$ 1.724,46 este mês, em 12 lançamentos.
> A maior fatia foi Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

**"quanto gastei com comida?"**
> 🍽️ R$ 389,40 em Alimentação este mês — R$ 12,98 por dia.
> A maior parte em Delivery (R$ 210,00).

**"tô gastando muito?"** — inform, do not judge. Compare against their own
history and the limits they set, then stop.
> Este mês está em R$ 1.724,46, 8% abaixo do mês passado.
> Dos seus limites, só Alimentação está apertado: 90% usado.

## Comparing periods

`summary` automatically compares against the preceding window of the same length.
For a full calendar month, the comparison is the previous calendar month — not
"30 days ago", which would straddle the month boundary and give a wrong number.

To compare two specific months, call `summary` twice:

    fin.ts summary --period 2026-07 --no-compare
    fin.ts summary --period 2026-08 --no-compare

## The scheduled reports

Cron fires five routines. They reach you as an ordinary instruction; what differs
is that nobody is waiting on the other end.

| When | What to do |
|---|---|
| Daily, 06:00 | `recurring apply`. If `silent` is true, reply only `[SILENT]`. |
| Daily, 21:00 | `report --period today --top 3`. If there were no transactions, reply only `[SILENT]`. |
| Sunday, 20:00 | `report --period week`, plus one closing sentence about the week. |
| 1st of the month, 09:00 | `report --period last-month`, plus a CSV export. |
| Every 3 hours | `alerts --mark`. If `silent` is true, reply only `[SILENT]`. |

**The `[SILENT]` rule:** when there is nothing to say, your entire reply must be
exactly `[SILENT]`, nothing else. The gateway recognises that marker and delivers
no message at all. If you reply "hoje não houve gastos", the user gets a pointless
notification — and a bot that notifies for no reason is a bot they mute.

## Export

    fin.ts export --period <p> [--format csv|json|md] [--dest <dir>]

CSV (the default) opens directly in Excel in Portuguese: `;` separator, decimal
comma, UTF-8 with a BOM. The response carries `file` with the full path — mention
that path in your reply and the gateway attaches the file on Telegram.

For a real `.xlsx` spreadsheet, Hermes ships an `xlsx` skill: export CSV first and
convert with it.

## What never to do in a report

- Invent or round a number that did not come from the tool.
- Recompute a percentage "just to check".
- Pass judgement on an expense ("gastou muito com delivery"). Show the number.
- Recommend cuts unasked. If asked, then advise, based on the data.
- Use a markdown table: Telegram does not render them, it arrives as a jumble.
