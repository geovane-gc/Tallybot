# Database schema

SQLite at `/opt/data/finance/tally.db` (on the host: `data/finance/tally.db`).

This document is here so you can **understand** the data — what a column means,
what `status` implies, why a budget on a parent captures its children. It is not a
query guide.

**Do not read or write this file directly. Use the subcommands.**

- Every row in here belongs to one of two people, and the scoping that keeps them
  apart lives in the CLI (`WHERE user_id = ?`, on every single query). A query you
  write yourself has no user in it, because **you do not know who you are talking
  to** — the CLI resolves that from the session and never tells you. So a
  hand-written `SELECT` either returns nothing useful or returns both people's
  money added together. There is no third outcome.
- Writing directly skips the amount parsing, the timezone handling, the paid /
  pending rules and the integrity checks, and produces rows the reports cannot
  interpret.
- If a subcommand does not answer the question, say so. Do not go around it.

## Conventions

- **Money:** integer cents, always positive. `2750` is R$ 27,50. The `type`
  column decides the direction, not the sign.
- **Dates:** `YYYY-MM-DD` text, in `America/Sao_Paulo`.
- **Timestamps:** ISO-8601 with offset.
- **Booleans:** integer 0/1.
- **Language:** identifiers are English; the *values* in `categories.name` and
  the seeded account are Portuguese, because the user reads them.
- **`user_id` on everything.** Two people share this file and their finances are
  separate. Every ledger table carries `user_id`, and every query in the CLI
  filters on it. A query without it sums two people's money together.

## Multi-user and authentication

Two rows in `users`, one per person, and nothing is shared between them except
the file itself.

The scoping, the access code and the operator-only commands are all enforced in the
CLI, which makes them **guardrails, not a security boundary**: anything running on
this host with a shell can open the file itself. The boundary is the Hermes gateway
allowlist, which decides whose messages reach the agent at all. That is precisely
why the rule above — use the subcommands, never the file — matters: it is the rule,
not the enforcement.

### `users`

`id`, `telegram_user_id` (TEXT, unique — text so a large Telegram id never loses
precision), `telegram_chat_id` (where scheduled reports go; only ever a private
chat), `display_name`, `authenticated_at`, `auth_epoch`, `active`, `created_at`.

- Someone may act only when `authenticated_at` is set, `active = 1` and
  `auth_epoch >= app_state.auth_epoch`.
- A row may exist with `authenticated_at` NULL: migration 2's `legacy` placeholder,
  or an id whose ledger was adopted before that person logged in. Such a row owns
  nothing it can reach. A wrong access code does **not** create a row.

### `app_state`

Global key/value, not per user. Three kinds of key:

- `auth_epoch` — `auth logout-all` increments it, which invalidates every session
  at once. **It deletes no data**: the transactions are untouched and reappear as
  soon as each person re-enters the code.
- `failed_attempts:<telegram id>` — wrong codes for one id. Five locks that id.
- `failed_attempts_global` — wrong codes across all ids. Twenty locks everybody,
  whatever id they claim, because the per-id counter is keyed by something the
  caller chooses and cycling ids used to buy five fresh attempts each time.

Only `auth unlock --user <id>` clears a lock (it clears that id's counter and the
global one together). `auth logout-all` deliberately does not — it used to, which
made the lockout undoable by a command that needs no authentication.

### `invites`

`id`, `code_hash` (SHA-256 of the normalised code, UNIQUE), `label`, `created_at`,
`expires_at`, `redeemed_at`, `redeemed_by_user_id`, `revoked_at`.

One code, one person, expiring — the way somebody is let in now. `auth invite`
mints one and prints the code **once**; only the hash is stored, so nothing can
print it again. The status (`pending` / `redeemed` / `expired` / `revoked`) is
derived from those three nullable columns, never stored.

Redemption is one transaction: the invite is consumed by a conditional UPDATE and
the user row is written inside the same transaction, so two simultaneous attempts
cannot both succeed. Unknown, expired, revoked and already-used codes all produce
the identical `Código incorreto.`, and every failure feeds the same lockout
counters above.

All four invite commands (`invite`, `invites`, `revoke-invite`, and `revoke` for a
person) are operator-only and refuse to run inside a chat turn. **You cannot let
anybody in** — only Geovane can, from his terminal.

The shared access code is **not in the database** either. It lives in the
`TALLY_ACCESS_CODE` environment variable, is checked only after no invite matched,
and is compared with a timing-safe comparison of SHA-256 digests. Do not try to
read, print or reconstruct either kind of code.

Two ways to take access away, and neither deletes anything:

- `auth revoke --user <id>` — one person. Sets `users.active = 0`, which
  `isSessionCurrent` already refuses, so that person needs a new invite. The other
  person never notices.
- `auth logout-all` — everybody re-enters a code (bumps `app_state.auth_epoch`).

### The legacy ledger

Migration 2 parked everything that predated multi-user support under a placeholder
whose `telegram_user_id` is the literal string `legacy`. Nobody can log in as it,
and `--user legacy` is refused. A normal login creates a *different* user with an
empty ledger, so those rows are not reachable by logging in — the owner has to
claim them explicitly, from the server:

    fin.ts auth adopt-legacy --user <telegram id>

That re-points every `user_id` in the ledger tables at that person, merging into
their existing row if there is one, and deletes the placeholder. It refuses when
the target already has transactions of their own: two real histories cannot be
merged without inventing renamed duplicates of somebody's accounts and categories.
Seeded-but-unused rows on the target are cleared to make room, and come back on the
next login.

Like every other operator command it refuses to run inside a chat turn.

## Tables

### `transactions` — the core ledger

| Column | Type | Note |
|---|---|---|
| `id` | INTEGER PK | The number the user sees and quotes to correct something |
| `user_id` | INTEGER FK | Whose transaction it is. Filter on it, always |
| `type` | TEXT | `expense` \| `income` \| `transfer` |
| `amount_cents` | INTEGER | Always > 0 (CHECK) |
| `description` | TEXT | Required |
| `date` | TEXT | When it happened — or, for a bill, when it is **due**. Not when it was recorded |
| `status` | TEXT | `paid` (default) \| `pending`. See "Paid and pending" below |
| `paid_at` | TEXT | When it was settled. NULL for a row that was born paid, and for anything still pending |
| `category_id` | INTEGER FK | NULL on a transfer |
| `account_id` | INTEGER FK | Source account |
| `dest_account_id` | INTEGER FK | Transfers only; required there (CHECK) |
| `note` | TEXT | |
| `source` | TEXT | `telegram` \| `recurring` \| `cron` \| `import` |
| `recurring_id` | INTEGER FK | Set when generated by a fixed cost |
| `installment_num` / `installment_total` | INTEGER | `3` and `12` in "3/12" |
| `installment_group` | TEXT | Same hash across every instalment of one purchase |
| `created_at` / `updated_at` | TEXT | |

### Paid and pending

`status` is the difference between money that is **gone** and money that is
**promised**:

- Everything typed into the chat is `paid`. You log an expense once it has
  happened, so that is the default and nothing about the ordinary flow changed.
- `recurring apply` creates the occurrence of a fixed cost as `pending` — due, not
  settled — unless the entry is `auto_debit` (the bank takes it by itself) or it is
  income (nobody has to pay their own salary in).
- **Balance counts `paid` only.** The money is still in the account until the bill
  is paid, and `balance` reports what is committed separately, per account, as
  `pending_cents`.
- **Budgets count `paid` + `pending`.** The point of a limit is not to spend the
  same money twice, and rent that is due is already committed. `spent_cents` is the
  paid part, `committed_cents` is the total, and `pct` / `status` follow the total.
- **Reports headline `paid`.** Pending shows up as its own "A pagar" block.

`recurring pay <id>` settles one (`--amount` overrides the value, `--date` records
when it was paid — the due date stays put, so the bill keeps belonging to its own
month). `recurring unpay <id>` undoes that, and only works on an occurrence of a
fixed cost.

### `accounts`

`id`, `user_id`, `name`, `type` (`checking`, `card`, `cash`, `savings`,
`investment`, `voucher`), `institution`, `closing_day`, `due_day`, `limit_cents`,
`opening_balance_cents`, `active`, `created_at`. Unique on `(user_id, name)`.

`closing_day` and `due_day` describe a credit card's statement cycle. `balance`
does not use `closing_day`: its `month_bill_fmt` is a rough calendar-month sum, so a
purchase made after the card closed is counted in the wrong statement. For the real
cycle — with its closing and due dates — use the `bill` subcommand.

Both people can have an account called "Nubank"; they are different rows with
different ids and unrelated balances.

A deactivated account (`active = 0`) drops out of listings but keeps its history.

### `categories`

`id`, `user_id`, `name`, `parent_id` (NULL = root), `type` (`expense`, `income`,
`both`), `emoji`, `active`. Unique on `(user_id, name, parent_id)`.

Two levels deep. Filtering or budgeting a root includes its children. Each person
gets their own copy of the taxonomy when they first authenticate, so one of them
renaming "Lazer" leaves the other's untouched.

### `budgets`

`id`, `user_id`, `category_id` (**NULL = the month's total cap**), `month`
(`YYYY-MM`; **NULL = applies to every month**), `limit_cents`, `alert_pct`,
`created_at`. Unique on `(user_id, category_id, month)`.

When both exist for the same category, the month-specific one wins.

### `recurring`

`id`, `user_id`, `description`, `type`, `amount_cents`, `category_id`,
`account_id`, `frequency` (`monthly`, `weekly`, `yearly`), `day`, `next_date`,
`ends_on`, `auto_debit`, `active`, `created_at`.

`recurring apply` runs for one person at a time: it generates that person's due
transactions up to today and advances their `next_date`. It is idempotent per
`(recurring_id, date)`. Cron fans it out over `auth users`.

`next_date` is the **schedule**, and it exists before any transaction does — which
is why `recurring due --in N` reads this table and not `transactions`. The day
before a bill falls due there is no occurrence yet, so a reminder built on
materialised rows would always be a day late.

`auto_debit = 1` means the money leaves on its own, so the generated occurrence is
`paid` immediately. With `0`, it is `pending` until somebody pays it.

### `goals`

`id`, `user_id`, `name`, `target_cents`, `saved_cents`, `deadline`, `active`,
`created_at`. Unique on `(user_id, name)`.

### `tags` and `transaction_tags`

`tags` is `id`, `user_id`, `name`, unique on `(user_id, name)` — the same word
tagged by both people is two rows. `transaction_tags` is the many-to-many join
and carries no `user_id` of its own; scope it through either side. It cascades
when a transaction is deleted.

### `sent_alerts`

`(user_id, key, month, level)` as the primary key, plus `sent_at`. This is what
stops cron from warning twice about the same limit, per person. `level` is
`warning` or `over` — moving from one to the other counts as a new alert.

### `settings`

Key/value pairs per person, `(user_id, key)` as the primary key: `currency`,
`timezone`, `default_account`. Each person has their own default account.

### `schema_version`

One row per applied migration. It is what makes `init` safe to run every time.
`init` creates and migrates the schema and nothing else — categories, the default
account and the settings are created when a person registers, not at install.

## The `v_transactions` view

Joins already resolved — query this, not the raw table:

`id`, `user_id`, `type`, `amount_cents`, `description`, `date`, `status`,
`paid_at`, `note`, `source`, `installment_num`, `installment_total`,
`installment_group`, `recurring_id`, `created_at`, `updated_at`, `category_id`,
`category`, `parent_category`, `category_emoji`, `account_id`, `account`,
`account_type`, `dest_account_id`, `dest_account`.

The view spans both people, which is the clearest reason not to read it yourself:
nothing in it is scoped until a query scopes it.

## How to query this

Through the CLI, always. There is no snippet here for opening the file yourself,
and that is deliberate: **reading the database directly bypasses the user scoping,
and must not be done.** You cannot scope a query correctly even if you try, because
the Telegram id of the person you are talking to is not available to you.

| The question | The subcommand |
|---|---|
| Anything about totals for a period | `summary --period <p>` |
| A ready-to-send report | `report --period <p>` |
| Individual transactions, filtered | `ls [--period] [--category] [--account] [--type] [--status] [--tag] [--text]` |
| Free-text lookup over descriptions and notes | `search "<term>"` |
| Balances, card bills, what is committed | `balance` |
| Limits | `budget status [--month]` |
| Fixed costs, what is due, what is unpaid | `recurring list` · `recurring due --in N` · `recurring pending` |
| Goals | `goal list` |
| The raw rows, for a spreadsheet | `export --format csv` |

If none of those answers the question, the honest answer is that you cannot get
that number, and the tool needs a new subcommand. Say that instead of improvising.

## Migrations

Defined in `scripts/db.ts`, in the `MIGRATIONS` array as `{version, sql}`. To
evolve the schema: append a new entry with the next version — never edit one that
has already been applied — and run `fin.ts init`.

Current version: **4**.

- **Migration 2** introduced `users` and `app_state`, added `user_id` to every
  ledger table and turned each UNIQUE constraint into a per-user one. Since SQLite
  cannot alter a constraint, it rebuilds each table (create new / copy / drop /
  rename) with foreign keys off, preserving ids. Rows that existed before it ran
  were attached to a placeholder user (`telegram_user_id = 'legacy'`) — see
  "The legacy ledger" above for how those are claimed. Nothing was deleted.
- **Migration 3** added `transactions.status` / `transactions.paid_at`,
  `recurring.auto_debit` and the `(user_id, status, date)` index, recreated
  `v_transactions` with the two new columns, and moved the failed-login counters
  from `users.failed_attempts` into `app_state` (dropping the column). Plain
  `ALTER TABLE ADD COLUMN`s this time: no constraint changed, so no rebuild was
  needed. `status` defaults to `'paid'`, which is what makes every row that
  existed before it — and every expense typed into the chat since — behave exactly
  as it did.
- **Migration 4** added `invites`: one single-use, expiring code per person,
  stored as a SHA-256 hash. Nothing else changed, and the shared
  `TALLY_ACCESS_CODE` still works — invites are checked first, the shared code
  second. What it buys is that one person can be cut off without disturbing the
  other (`auth revoke --user`), and that once everybody has redeemed an invite the
  shared code can be deleted from the environment, leaving no standing secret.
  It does **not** isolate the two people from each other: same container, same
  file, same shell. See the top of this document.
