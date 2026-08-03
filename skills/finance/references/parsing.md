# Reading Portuguese messages

How to turn what the user writes into a `fin.ts add` call.

Remember: **you convert neither amount nor date.** You extract the fragment and
pass it through. The tool handles Brazilian formats and the São Paulo timezone.

## The minimum shape

Almost everything arrives as "what" plus "how much", in either order:

    uber 27              → --amount 27    --description "Uber"
    27 uber              → --amount 27    --description "Uber"
    mercado 234,56       → --amount 234,56 --description "Mercado"
    gastei 50 no cinema  → --amount 50    --description "Cinema"

The number is the amount; the rest is the description. Capitalise the
description, but keep proper nouns as they are ("iFood", "99", "Uber").

## Amounts

| Written | Pass as | Means |
|---|---|---|
| `27` | `27` | R$ 27,00 |
| `27,50` / `27.50` | `27,50` | R$ 27,50 |
| `1.234,56` | `1.234,56` | R$ 1.234,56 |
| `R$ 89,90` | `89,90` | R$ 89,90 |
| `1,2k` / `1.2k` | `1,2k` | R$ 1.200,00 |
| `2 mil` | `2k` | R$ 2.000,00 |
| `30 reais` | `30` | R$ 30,00 |
| `27 e 50` | `27,50` | R$ 27,50 |
| `cinquenta reais` | `50` | R$ 50,00 |

A number spelled out in words: convert just the numeral ("cinquenta" → `50`,
"cento e vinte" → `120`). If you are not certain what they meant, ask.

**Signs of ambiguity — ask:**
- `gastei uns 30 e pouco` → "Foi quanto exatamente?"
- `2 e meio` with no context → could be 2,50 or 2500.
- No number in the message, but it reads like an expense.

## Dates

Pass the literal fragment to `--date`. These the tool understands:

`hoje`, `agora`, `ontem`, `anteontem`, `amanha`, `dia 7`, `03/08`, `03/08/2026`,
`2026-08-03` (and the English `today` / `yesterday` / `tomorrow`).

With no `--date`, it is today — which covers most messages.

**Phrasings you must resolve first**, because the tool does not know them. For
these, get today's date with `date +%F` in the terminal, work it out, and pass
ISO:

- "sexta passada", "no sábado", "segunda"
- "semana passada" for a *transaction* — if it is a query, use `--period last-week`
- "no começo do mês", "no dia do meu aniversário"

If the phrasing is too vague ("há umas duas semanas"), ask for the date.

## Accounts and payment methods

Users mix account, bank and payment method in the same sentence:

    89,90 no ifood no nubank      → --account Nubank
    paguei no crédito             → --account <their card>
    no débito do itaú             → --account "Itaú"
    pix 50                        → default account (PIX is not an account)
    em dinheiro                   → --account Carteira
    no vr / no vale               → --account <the voucher, if registered>

With no account mentioned, **do not ask** — it goes to the default account.
Correcting later is one message; asking on every expense is friction that makes
the user stop using the bot.

If they name an account that does not exist, the command fails with
`Conta "X" não existe`. *Then* run `account list`, show the options and offer to
register it.

## Instalments

    3600 em 12x           → --amount 3600 --installments 12
    12 vezes de 300       → --amount 3600 --installments 12   (300 × 12)
    parcelei em 3         → --installments 3

Mind the difference: `em 12x` is usually the **total**; `12 vezes de 300` is the
**instalment** amount. If they gave the instalment, multiply and pass the total —
the tool divides it back without losing a cent. When unsure, confirm: "R$ 3.600
no total ou 12 parcelas de R$ 3.600?"

## Income

Words that signal money coming in, and require `--type income`:

`recebi`, `caiu`, `entrou`, `me pagaram`, `salário`, `pagamento`, `freela`,
`vendi`, `reembolso`, `estorno`, `cashback`, `rendeu`, `dividendo`, `plr`.

Without one of those, assume an expense — by far the more common case.

Watch the trap: "paguei o freela do designer" is an **expense** (they paid),
not income. Look at which way the money moved, not just the keyword.

## Transfers

`transferi`, `passei da conta pra`, `mandei pra poupança`, `saquei`,
`paguei a fatura`, `apliquei`.

Requires `--type transfer`, `--account` (source) and `--dest-account`.

If one end is missing, ask which account. Here asking is worth it: a transfer with
the wrong account distorts two balances.

## Several items in one message

    "30 no almoço e 12 no café"
    "mercado 200, farmácia 45 e uber 18"

One `add` call per item. Then confirm them together:

> ✅ Registrei 3:
> • R$ 200,00 · Mercado (#150)
> • R$ 45,00 · Farmácia (#151)
> • R$ 18,00 · Uber (#152)

## Corrections

References to the last transaction — use the id you just confirmed:

| They say | Action |
|---|---|
| `não, foi 37` | `edit <id> --amount 37` |
| `era no cartão` | `edit <id> --account <card>` |
| `isso foi ontem` | `edit <id> --date ontem` |
| `era mercado, não restaurante` | `edit <id> --category Mercado` |
| `apaga` / `cancela isso` | `rm <id>` |
| `esse era parcelado em 3` | `rm <id>` then `add` again with `--installments 3` |

If they correct something that is **not** the last transaction ("aquele uber de
terça estava errado"), locate it with `ls` or `search` first, and confirm which
one before changing it.

## Questions versus transactions

Not every message with a number is an expense:

| Message | It is |
|---|---|
| `uber 27` | a transaction |
| `quanto gastei com uber?` | a query → `ls --category "Uber/99" --period month` |
| `limite de 500 pra alimentação` | a budget → `budget set` |
| `quanto tenho na conta?` | a query → `balance` |
| `meu aluguel é 1500 todo dia 5` | a fixed cost → `recurring add` |
| `quero juntar 15 mil pra viajar` | a goal → `goal add` |

A past-tense verb ("gastei", "paguei", "comprei") is a transaction. A question
("quanto", "quais", "como está") is a query. A statement of intent ("quero",
"meu X é", "todo mês") is configuration — budget, recurring or goal.

## Messages that are not about money

Answer naturally and briefly, in Portuguese. Do not force a transaction, do not
recite the feature list. If they say "bom dia", say good morning back.
