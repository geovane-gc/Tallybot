/**
 * Data layer for the finance agent.
 *
 * Decisions worth knowing before touching this file:
 *
 * - Money is an integer count of cents, behind a branded `Cents` type. Never a
 *   float: `27.50` would drift to `27.499999...` somewhere and a monthly report
 *   would accumulate the error. The brand also stops you from passing whole
 *   currency units where cents are expected — the easiest mistake to make here.
 *
 * - Dates are `YYYY-MM-DD` strings interpreted in `America/Sao_Paulo`. The
 *   container runs in UTC, so reading "today" without a timezone would file a
 *   10pm Tuesday expense under Wednesday. All calendar arithmetic goes through
 *   `Date.UTC` on the date components, never the process-local timezone.
 *
 * - Migrations are idempotent and versioned in `MIGRATIONS`; `migrate()` is safe
 *   to run on every boot and applies only what is missing. Never edit a
 *   migration that has already shipped — append a new one.
 *
 * - Two people share this ledger and their money is fully separated: every
 *   per-user table carries `user_id`, and every query has to filter on it. The
 *   helpers here take `userId` as an explicit parameter and never default it,
 *   because a silent default is exactly how one person ends up seeing the
 *   other's balance.
 *
 * - Getting in is a per-person invite: a single-use code the owner mints in the
 *   terminal and dictates in person, of which only the SHA-256 is stored. The
 *   shared `TALLY_ACCESS_CODE` still works as the simple mode, and once everybody
 *   has redeemed an invite it can be deleted from the environment, leaving no
 *   standing secret anywhere. Cutting one person off is `auth revoke --user`,
 *   which flips `users.active` and touches nobody else. See migration 4.
 *
 * - A transaction is either `paid` or `pending`. `paid` is the default and covers
 *   everything typed into the chat: you log an expense once the money is gone.
 *   `pending` exists for a generated fixed cost that is due but not settled yet —
 *   it counts against the month's budget (the money is committed) and stays out
 *   of the balance (the money is still there). See migration 3.
 *
 * - Zero dependencies: `node:sqlite` is built in, so there is no `node_modules`,
 *   no build step and no native module to compile.
 *
 * - None of the checks in this codebase are a security boundary. The agent that
 *   calls the CLI runs a shell as the same uid and can open this file with
 *   `node:sqlite` directly, so user scoping, the lockout and the operator-only
 *   commands are guardrails: they keep a promptable model from doing the wrong
 *   thing by accident or on request. The boundary is the Hermes gateway
 *   allowlist, one level up.
 *
 * Language split, applied throughout the codebase: identifiers, comments, table
 * and column names, and JSON keys are English. Anything the user ever reads is
 * Portuguese — `FinError` messages (the agent relays them into the chat),
 * category names, period labels and report text. When in doubt, ask whether the
 * string can reach Telegram.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";

export type Cents = number & { readonly __brand: unique symbol };

export type TransactionType = "expense" | "income" | "transfer";
/** `paid` = the money moved. `pending` = due, committed, not out yet. */
export type TransactionStatus = "paid" | "pending";
export type AccountType =
  | "checking"
  | "card"
  | "cash"
  | "savings"
  | "investment"
  | "voucher";
export type CategoryType = "expense" | "income" | "both";
export type Frequency = "monthly" | "weekly" | "yearly";
export type BudgetStatus = "ok" | "warning" | "over";

export const TRANSACTION_TYPES: readonly TransactionType[] = [
  "expense",
  "income",
  "transfer",
];
export const TRANSACTION_STATUSES: readonly TransactionStatus[] = ["paid", "pending"];
export const ACCOUNT_TYPES: readonly AccountType[] = [
  "checking",
  "card",
  "cash",
  "savings",
  "investment",
  "voucher",
];

export const DEFAULT_DB = process.env.TALLY_DB ?? "/opt/data/finance/tally.db";

export const CURRENT_SCHEMA_VERSION = 4;

const TZ = "America/Sao_Paulo";

/** Consecutive wrong codes before that Telegram id stops accepting attempts. */
export const MAX_FAILED_ATTEMPTS = 5;

/**
 * Wrong codes across *all* ids before nobody may try again.
 *
 * The per-id counter alone is not a limit: whoever is guessing controls the id
 * they claim to be, so every new value bought five fresh attempts. This one is
 * global, and 20 is four full per-id budgets — high enough that two people
 * mistyping the code on a bad day do not trip it, low enough that enumerating
 * ids stops being a way around the lockout. Only `auth unlock` lifts it.
 */
export const MAX_GLOBAL_FAILED_ATTEMPTS = 20;

/**
 * The largest amount the ledger accepts, in cents — R$ 100.000.000,00.
 *
 * Anything above this is a typo or a probe, never a grocery bill. Without a
 * ceiling, `1e307` reached SQLite as `Infinity` and came back as a raw
 * "NOT NULL constraint failed" in the middle of a chat.
 */
export const MAX_AMOUNT_CENTS = 10_000_000_000;

/**
 * An expected error whose message is safe to show the end user.
 *
 * The CLI turns this into `{"ok": false, "error": "..."}` and the agent relays
 * the text to Telegram. That is why these messages talk about money rather than
 * about SQL.
 */
export class FinError extends Error {}

/**
 * The caller is not authenticated (never was, or the session was revoked).
 *
 * The CLI adds `"auth_required": true` to the response for this one, and that
 * flag is the agent's single cue to ask for the access code. Deliberately the
 * same error for "unknown id" and "revoked session": the agent handles one case,
 * and an outsider probing ids learns nothing.
 */
export class AuthRequiredError extends FinError {}

export const cents = (n: number): Cents => n as Cents;

/** Today's date in São Paulo, as `YYYY-MM-DD`. */
export function today(): string {
  // `en-CA` formats as YYYY-MM-DD, and `timeZone` resolves the zone without
  // depending on the process TZ.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * One instant as an ISO timestamp with the São Paulo offset.
 *
 * Every audit column in this schema holds this exact shape, and because the
 * offset is always the same literal `-03:00` (Brazil dropped DST in 2019), two of
 * these strings compare as timestamps with `<`. `invites.expires_at` relies on
 * that, in SQL and in TypeScript.
 */
function formatTimestamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}-03:00`;
}

/** ISO timestamp with the São Paulo offset, for the audit columns. */
export function now(): string {
  return formatTimestamp(new Date());
}

/** The same timestamp, N hours later. Used for an invite's expiry. */
export function addHours(timestamp: string, hours: number): string {
  return formatTimestamp(new Date(new Date(timestamp).getTime() + hours * 3_600_000));
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function dateParts(iso: string): Ymd {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function buildDate(year: number, month: number, day: number, original: unknown): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC normalises silently (Feb 31 becomes Mar 3); comparing back is what
  // catches a date that does not exist.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new FinError(`Data inexistente: ${String(original)}`);
  }
  return formatUtc(d);
}

function formatUtc(d: Date): string {
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

function asUtc(iso: string): Date {
  const { year, month, day } = dateParts(iso);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(iso: string, days: number): string {
  const d = asUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtc(d);
}

/**
 * Advances N months, keeping the day of month where possible.
 *
 * Jan 31 + 1 month = Feb 28 (or 29 in a leap year), which is what credit-card
 * instalments expect.
 */
export function addMonths(iso: string, months: number): string {
  if (months === 0) return iso;
  const { year, month, day } = dateParts(iso);
  const total = month - 1 + months;
  const newYear = year + Math.floor(total / 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  const last = lastDayOfMonth(newYear, newMonth);
  return buildDate(newYear, newMonth, Math.min(day, last), iso);
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of week, 0 = Sunday. */
function dayOfWeek(iso: string): number {
  return asUtc(iso).getUTCDay();
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Lowercase, accent-free — so names typed any which way still match. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Converts the date the agent passed into `YYYY-MM-DD`.
 *
 * Accepts ISO, `DD/MM`, `MM/DD/YYYY`-free unambiguous forms, and the common
 * relative words. The agent resolves some phrasing itself, but handling the
 * frequent cases here keeps a weaker model from doing calendar arithmetic — and
 * a wrong date in a ledger contaminates every report built on top of it.
 *
 * Portuguese relatives are accepted too: this bot serves a Brazilian user who
 * will sometimes type "ontem" out of habit.
 */
export function parseDate(value?: string | null): string {
  if (value === undefined || value === null || String(value).trim() === "") {
    return today();
  }

  const text = normalize(String(value));

  const relative: Record<string, number> = {
    today: 0,
    now: 0,
    yesterday: -1,
    tomorrow: 1,
    hoje: 0,
    agora: 0,
    ontem: -1,
    anteontem: -2,
    amanha: 1,
  };
  if (text in relative) return addDays(today(), relative[text]);

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return buildDate(+m[1], +m[2], +m[3], value);

  // Day-first, matching how dates are written in Brazil.
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (m) {
    const year = +m[3] < 100 ? +m[3] + 2000 : +m[3];
    return buildDate(year, +m[2], +m[1], value);
  }

  // DD/MM with no year: assume the current one, but if that lands more than a
  // month ahead, it was last year (the case of logging "28/12" in January).
  m = /^(\d{1,2})[/\-.](\d{1,2})$/.exec(text);
  if (m) {
    const ref = today();
    const candidate = buildDate(dateParts(ref).year, +m[2], +m[1], value);
    if (candidate > addDays(ref, 31)) {
      return buildDate(dateParts(ref).year - 1, +m[2], +m[1], value);
    }
    return candidate;
  }

  m = /^(?:day|dia) (\d{1,2})$/.exec(text);
  if (m) {
    const { year, month } = dateParts(today());
    return buildDate(year, month, +m[1], value);
  }

  throw new FinError(
    `Não entendi a data ${JSON.stringify(value)}. Use YYYY-MM-DD, DD/MM ou 'hoje'/'ontem'.`,
  );
}

/**
 * Converts a monetary value into cents.
 *
 * Accepts what a model produces from spoken language: `27`, `27.5`, `"27,50"`,
 * `"R$ 1.234,56"`, `"1.2k"`, `"30 reais"`.
 *
 * The rule that matters: when both a comma and a dot are present, the comma is
 * the decimal separator (Brazilian convention). With only a dot, the shape
 * decides — `1.234` is one thousand two hundred thirty-four, `27.50` is
 * twenty-seven and a half.
 */
export function parseAmount(value: unknown): Cents {
  let total: number;

  if (typeof value === "boolean" || value === null || value === undefined) {
    throw new FinError("Valor inválido.");
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FinError("Valor inválido.");
    total = Math.round(value * 100);
  } else {
    let text = normalize(String(value))
      .replaceAll("r$", "")
      .replaceAll("reais", "")
      .replaceAll("real", "")
      .replaceAll("brl", "")
      .replaceAll(" ", "")
      .trim();

    if (!text) throw new FinError("Valor não informado.");

    let multiplier = 1;
    if (text.endsWith("mil")) {
      multiplier = 1000;
      text = text.slice(0, -3);
    } else if (text.endsWith("k")) {
      multiplier = 1000;
      text = text.slice(0, -1);
    }

    const negative = text.startsWith("-");
    text = text.replace(/^[-+]+/, "");

    const hasComma = text.includes(",");
    const dots = (text.match(/\./g) ?? []).length;

    if (hasComma && dots > 0) {
      text = text.replaceAll(".", "").replace(",", ".");
    } else if (hasComma) {
      text = text.replace(",", ".");
    } else if (dots === 1) {
      const [whole, frac] = text.split(".");
      // 1.234 = thousands separator; 27.5 and 27.50 = decimal
      if (frac.length === 3 && whole.length <= 3) text = whole + frac;
    } else if (dots > 1) {
      text = text.replaceAll(".", "");
    }

    const parsed = Number(text);
    if (!Number.isFinite(parsed) || text === "") {
      throw new FinError(`Não consegui ler o valor ${JSON.stringify(value)}.`);
    }
    total = Math.round(parsed * multiplier * 100);
    if (negative) total = -total;
  }

  // `1e307` parses fine and then overflows to Infinity once multiplied by 100,
  // which used to reach SQLite and surface as a constraint error in the chat.
  if (!Number.isFinite(total)) throw new FinError("Valor inválido.");
  if (total === 0) throw new FinError("O valor precisa ser maior que zero.");
  if (Math.abs(total) > MAX_AMOUNT_CENTS) {
    throw new FinError(
      `Esse valor é alto demais para eu registrar (máximo ${formatMoney(MAX_AMOUNT_CENTS)}). ` +
        "Confere se não sobrou um zero.",
    );
  }
  return cents(Math.abs(total));
}

/**
 * Formats cents as `R$ 1,234.56`… in Brazilian notation: `R$ 1.234,56`.
 *
 * The currency is BRL because that is what this ledger holds. Changing it means
 * changing this function and the seeded `currency` setting together.
 */
export function formatMoney(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(value));
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}R$ ${whole.toLocaleString("pt-BR")},${String(rest).padStart(2, "0")}`;
}

export interface Period {
  start: string;
  end: string;
  label: string;
}

/**
 * Turns a named period into `{start, end, label}`.
 *
 * Accepts: today, yesterday, week, last-week, month, last-month, full-month,
 * year, last-year, all, `Nd` (last N days) and `YYYY-MM`.
 */
export function periodRange(period?: string, reference?: string): Period {
  const ref = reference ?? today();
  const p = normalize(period ?? "month");
  const { year, month } = dateParts(ref);

  // Weeks start on Monday.
  const sinceMonday = (dayOfWeek(ref) + 6) % 7;

  switch (p) {
    case "today":
    case "day":
      return { start: ref, end: ref, label: "hoje" };
    case "yesterday": {
      const d = addDays(ref, -1);
      return { start: d, end: d, label: "ontem" };
    }
    case "week":
    case "this-week":
      return { start: addDays(ref, -sinceMonday), end: ref, label: "esta semana" };
    case "last-week": {
      const start = addDays(ref, -sinceMonday - 7);
      return { start, end: addDays(start, 6), label: "semana passada" };
    }
    case "month":
    case "this-month":
      return { start: buildDate(year, month, 1, p), end: ref, label: "este mês" };
    case "last-month": {
      const end = addDays(buildDate(year, month, 1, p), -1);
      const e = dateParts(end);
      return { start: buildDate(e.year, e.month, 1, p), end, label: "mês passado" };
    }
    case "full-month":
      return {
        start: buildDate(year, month, 1, p),
        end: buildDate(year, month, lastDayOfMonth(year, month), p),
        label: "mês corrente",
      };
    case "year":
    case "this-year":
      return { start: `${year}-01-01`, end: ref, label: "este ano" };
    case "last-year":
      return {
        start: `${year - 1}-01-01`,
        end: `${year - 1}-12-31`,
        label: "ano passado",
      };
    case "all":
    case "ever":
      return { start: "0001-01-01", end: ref, label: "todo o histórico" };
  }

  let m = /^(\d+)\s*d(ays)?$/.exec(p);
  if (m) {
    const n = +m[1];
    return {
      start: addDays(ref, -(n - 1)),
      end: ref,
      label: `últimos ${n} dias`,
    };
  }

  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) {
    const y = +m[1];
    const mm = +m[2];
    if (mm < 1 || mm > 12) throw new FinError(`Mês inválido em ${JSON.stringify(period)}.`);
    return {
      start: `${m[1]}-${m[2]}-01`,
      end: buildDate(y, mm, lastDayOfMonth(y, mm), p),
      label: `${m[2]}/${m[1]}`,
    };
  }

  throw new FinError(
    `Período ${JSON.stringify(period)} não reconhecido. Use hoje, semana, mes, ` +
      `mes-passado, 30d, ano ou YYYY-MM.`,
  );
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/**
 * `now()` as a SQL expression, for migrations.
 *
 * `MIGRATIONS` is static text, so a timestamp has to be computed by SQLite. The
 * `-3 hours` shift plus the literal offset reproduce what `now()` returns in
 * São Paulo, which is the format every audit column already holds.
 */
const SQL_NOW = "(strftime('%Y-%m-%dT%H:%M:%S','now','-3 hours') || '-03:00')";

/**
 * The placeholder user that inherits rows written before multi-user support.
 *
 * Nobody can log in as it: `--user legacy` is rejected, and a real login creates
 * a separate user with an empty ledger. Claiming that history is a deliberate,
 * operator-run step — `auth adopt-legacy --user <telegram id>`, which re-points
 * these rows and removes the placeholder. Until then they sit here, reachable by
 * nothing.
 */
const LEGACY_USER_ID = "(SELECT id FROM users WHERE telegram_user_id = 'legacy')";

const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE accounts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT    NOT NULL UNIQUE,
        type           TEXT    NOT NULL DEFAULT 'checking'
                         CHECK (type IN ('checking','card','cash',
                                         'savings','investment','voucher')),
        institution    TEXT,
        closing_day    INTEGER CHECK (closing_day BETWEEN 1 AND 31),
        due_day        INTEGER CHECK (due_day BETWEEN 1 AND 31),
        limit_cents    INTEGER,
        opening_balance_cents INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT    NOT NULL
    );

    CREATE TABLE categories (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT    NOT NULL,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        type      TEXT    NOT NULL DEFAULT 'expense'
                    CHECK (type IN ('expense','income','both')),
        emoji     TEXT,
        active    INTEGER NOT NULL DEFAULT 1,
        UNIQUE (name, parent_id)
    );

    CREATE TABLE recurring (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        description  TEXT    NOT NULL,
        type         TEXT    NOT NULL DEFAULT 'expense'
                       CHECK (type IN ('expense','income')),
        amount_cents INTEGER NOT NULL,
        category_id  INTEGER REFERENCES categories(id),
        account_id   INTEGER REFERENCES accounts(id),
        frequency    TEXT    NOT NULL DEFAULT 'monthly'
                       CHECK (frequency IN ('monthly','weekly','yearly')),
        day          INTEGER NOT NULL DEFAULT 1,
        next_date    TEXT    NOT NULL,
        ends_on      TEXT,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL
    );

    CREATE TABLE transactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        type              TEXT    NOT NULL
                            CHECK (type IN ('expense','income','transfer')),
        amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
        description       TEXT    NOT NULL,
        date              TEXT    NOT NULL,
        category_id       INTEGER REFERENCES categories(id),
        account_id        INTEGER REFERENCES accounts(id),
        dest_account_id   INTEGER REFERENCES accounts(id),
        note              TEXT,
        source            TEXT    NOT NULL DEFAULT 'telegram',
        recurring_id      INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
        installment_num   INTEGER,
        installment_total INTEGER,
        installment_group TEXT,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        CHECK (type <> 'transfer' OR dest_account_id IS NOT NULL),
        CHECK (dest_account_id IS NULL OR dest_account_id <> account_id)
    );

    CREATE INDEX idx_tx_date     ON transactions(date);
    CREATE INDEX idx_tx_category ON transactions(category_id, date);
    CREATE INDEX idx_tx_account  ON transactions(account_id, date);
    CREATE INDEX idx_tx_type     ON transactions(type, date);
    CREATE INDEX idx_tx_group    ON transactions(installment_group);

    CREATE TABLE tags (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE transaction_tags (
        transaction_id INTEGER NOT NULL
                         REFERENCES transactions(id) ON DELETE CASCADE,
        tag_id         INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (transaction_id, tag_id)
    );

    CREATE TABLE budgets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        month       TEXT,
        limit_cents INTEGER NOT NULL CHECK (limit_cents > 0),
        alert_pct   INTEGER NOT NULL DEFAULT 80
                      CHECK (alert_pct BETWEEN 1 AND 100),
        created_at  TEXT    NOT NULL,
        UNIQUE (category_id, month)
    );

    CREATE TABLE goals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        target_cents INTEGER NOT NULL CHECK (target_cents > 0),
        saved_cents  INTEGER NOT NULL DEFAULT 0,
        deadline     TEXT,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL
    );

    CREATE TABLE sent_alerts (
        key     TEXT NOT NULL,
        month   TEXT NOT NULL,
        level   TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (key, month, level)
    );

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE schema_version (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    );

    CREATE VIEW v_transactions AS
    SELECT
        t.id, t.type, t.amount_cents, t.description, t.date,
        t.note, t.source, t.installment_num, t.installment_total,
        t.installment_group, t.recurring_id, t.created_at, t.updated_at,
        t.category_id,
        COALESCE(c.name, 'Sem categoria') AS category,
        cp.name                           AS parent_category,
        c.emoji                           AS category_emoji,
        t.account_id,
        COALESCE(a.name, 'Sem conta')     AS account,
        a.type                            AS account_type,
        t.dest_account_id,
        ad.name                           AS dest_account
    FROM transactions t
    LEFT JOIN categories c  ON c.id  = t.category_id
    LEFT JOIN categories cp ON cp.id = c.parent_id
    LEFT JOIN accounts a    ON a.id  = t.account_id
    LEFT JOIN accounts ad   ON ad.id = t.dest_account_id;
    `,
  },
  {
    // Multi-user. Two people share the bot, so every ledger table gains
    // `user_id` and every UNIQUE constraint becomes per-user.
    //
    // SQLite cannot alter a UNIQUE constraint, hence the create-new / copy /
    // drop / rename dance for every table. Foreign keys are switched off for the
    // duration: with them on, `ALTER TABLE ... RENAME` would rewrite the
    // REFERENCES clauses of the other tables and point them at the `_v2`
    // scratch names. Ids are preserved on copy, so existing references and the
    // ids the user already quoted in chat stay valid.
    version: 2,
    sql: `
    PRAGMA foreign_keys = OFF;

    CREATE TABLE users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        -- TEXT, not INTEGER: Telegram ids are already past 2^32 and a JSON
        -- number would eventually lose precision. As text they never do.
        telegram_user_id TEXT    NOT NULL UNIQUE,
        -- Where to deliver this person's scheduled reports. Recorded at login
        -- from the session, and only when the conversation is a private one —
        -- a group chat id here would publish somebody's ledger to the group.
        telegram_chat_id TEXT,
        display_name     TEXT,
        authenticated_at TEXT,
        auth_epoch       INTEGER NOT NULL DEFAULT 0,
        failed_attempts  INTEGER NOT NULL DEFAULT 0,
        active           INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT    NOT NULL
    );

    -- Global, not per user: 'auth_epoch' lives here, and bumping it is what
    -- logs everybody out at once.
    CREATE TABLE app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    INSERT INTO app_state (key, value) VALUES ('auth_epoch', '0');

    -- Recreated at the end, exposing user_id.
    DROP VIEW v_transactions;

    -- Anything already in the database belongs to whoever was using the bot
    -- before this migration. It gets attached to a placeholder user with
    -- authenticated_at NULL; the rows are never dropped. Logging in is NOT
    -- enough to reach them — a login creates a different user with an empty
    -- ledger — so claiming them is an explicit operator step,
    -- 'auth adopt-legacy --user <telegram id>'. Skipped entirely on a database
    -- that is empty (a fresh install, where migration 1 has just created bare
    -- tables).
    INSERT INTO users (telegram_user_id, telegram_chat_id, display_name,
                       authenticated_at, auth_epoch, created_at)
    SELECT 'legacy', NULL, 'Legacy', NULL, 0, ${SQL_NOW}
     WHERE EXISTS (SELECT 1 FROM accounts)
        OR EXISTS (SELECT 1 FROM categories)
        OR EXISTS (SELECT 1 FROM transactions)
        OR EXISTS (SELECT 1 FROM budgets)
        OR EXISTS (SELECT 1 FROM recurring)
        OR EXISTS (SELECT 1 FROM goals)
        OR EXISTS (SELECT 1 FROM tags)
        OR EXISTS (SELECT 1 FROM sent_alerts)
        OR EXISTS (SELECT 1 FROM settings);

    CREATE TABLE accounts_v2 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name           TEXT    NOT NULL,
        type           TEXT    NOT NULL DEFAULT 'checking'
                         CHECK (type IN ('checking','card','cash',
                                         'savings','investment','voucher')),
        institution    TEXT,
        closing_day    INTEGER CHECK (closing_day BETWEEN 1 AND 31),
        due_day        INTEGER CHECK (due_day BETWEEN 1 AND 31),
        limit_cents    INTEGER,
        opening_balance_cents INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT    NOT NULL,
        UNIQUE (user_id, name)
    );
    INSERT INTO accounts_v2 (id, user_id, name, type, institution, closing_day,
                             due_day, limit_cents, opening_balance_cents,
                             active, created_at)
    SELECT id, ${LEGACY_USER_ID}, name, type, institution, closing_day,
           due_day, limit_cents, opening_balance_cents, active, created_at
      FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_v2 RENAME TO accounts;
    CREATE INDEX idx_accounts_user ON accounts(user_id, active);

    CREATE TABLE categories_v2 (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name      TEXT    NOT NULL,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        type      TEXT    NOT NULL DEFAULT 'expense'
                    CHECK (type IN ('expense','income','both')),
        emoji     TEXT,
        active    INTEGER NOT NULL DEFAULT 1,
        UNIQUE (user_id, name, parent_id)
    );
    INSERT INTO categories_v2 (id, user_id, name, parent_id, type, emoji, active)
    SELECT id, ${LEGACY_USER_ID}, name, parent_id, type, emoji, active
      FROM categories;
    DROP TABLE categories;
    ALTER TABLE categories_v2 RENAME TO categories;
    CREATE INDEX idx_categories_user ON categories(user_id, active);

    CREATE TABLE recurring_v2 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        description  TEXT    NOT NULL,
        type         TEXT    NOT NULL DEFAULT 'expense'
                       CHECK (type IN ('expense','income')),
        amount_cents INTEGER NOT NULL,
        category_id  INTEGER REFERENCES categories(id),
        account_id   INTEGER REFERENCES accounts(id),
        frequency    TEXT    NOT NULL DEFAULT 'monthly'
                       CHECK (frequency IN ('monthly','weekly','yearly')),
        day          INTEGER NOT NULL DEFAULT 1,
        next_date    TEXT    NOT NULL,
        ends_on      TEXT,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL
    );
    INSERT INTO recurring_v2 (id, user_id, description, type, amount_cents,
                              category_id, account_id, frequency, day,
                              next_date, ends_on, active, created_at)
    SELECT id, ${LEGACY_USER_ID}, description, type, amount_cents,
           category_id, account_id, frequency, day,
           next_date, ends_on, active, created_at
      FROM recurring;
    DROP TABLE recurring;
    ALTER TABLE recurring_v2 RENAME TO recurring;
    CREATE INDEX idx_recurring_user ON recurring(user_id, active, next_date);

    CREATE TABLE transactions_v2 (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type              TEXT    NOT NULL
                            CHECK (type IN ('expense','income','transfer')),
        amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
        description       TEXT    NOT NULL,
        date              TEXT    NOT NULL,
        category_id       INTEGER REFERENCES categories(id),
        account_id        INTEGER REFERENCES accounts(id),
        dest_account_id   INTEGER REFERENCES accounts(id),
        note              TEXT,
        source            TEXT    NOT NULL DEFAULT 'telegram',
        recurring_id      INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
        installment_num   INTEGER,
        installment_total INTEGER,
        installment_group TEXT,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        CHECK (type <> 'transfer' OR dest_account_id IS NOT NULL),
        CHECK (dest_account_id IS NULL OR dest_account_id <> account_id)
    );
    INSERT INTO transactions_v2 (id, user_id, type, amount_cents, description,
                                 date, category_id, account_id, dest_account_id,
                                 note, source, recurring_id, installment_num,
                                 installment_total, installment_group,
                                 created_at, updated_at)
    SELECT id, ${LEGACY_USER_ID}, type, amount_cents, description,
           date, category_id, account_id, dest_account_id,
           note, source, recurring_id, installment_num,
           installment_total, installment_group, created_at, updated_at
      FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_v2 RENAME TO transactions;

    -- Every listing, total and report filters by user first and then by date,
    -- so user_id leads every composite index.
    CREATE INDEX idx_tx_user_date     ON transactions(user_id, date);
    CREATE INDEX idx_tx_user_category ON transactions(user_id, category_id, date);
    CREATE INDEX idx_tx_user_account  ON transactions(user_id, account_id, date);
    CREATE INDEX idx_tx_user_type     ON transactions(user_id, type, date);
    CREATE INDEX idx_tx_user_dest     ON transactions(user_id, dest_account_id);
    CREATE INDEX idx_tx_recurring     ON transactions(recurring_id, date);
    CREATE INDEX idx_tx_group         ON transactions(installment_group);

    CREATE TABLE tags_v2 (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name    TEXT NOT NULL,
        UNIQUE (user_id, name)
    );
    INSERT INTO tags_v2 (id, user_id, name)
    SELECT id, ${LEGACY_USER_ID}, name FROM tags;
    DROP TABLE tags;
    ALTER TABLE tags_v2 RENAME TO tags;
    CREATE INDEX idx_tags_user ON tags(user_id);

    CREATE TABLE budgets_v2 (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        month       TEXT,
        limit_cents INTEGER NOT NULL CHECK (limit_cents > 0),
        alert_pct   INTEGER NOT NULL DEFAULT 80
                      CHECK (alert_pct BETWEEN 1 AND 100),
        created_at  TEXT    NOT NULL,
        UNIQUE (user_id, category_id, month)
    );
    INSERT INTO budgets_v2 (id, user_id, category_id, month, limit_cents,
                            alert_pct, created_at)
    SELECT id, ${LEGACY_USER_ID}, category_id, month, limit_cents,
           alert_pct, created_at
      FROM budgets;
    DROP TABLE budgets;
    ALTER TABLE budgets_v2 RENAME TO budgets;
    CREATE INDEX idx_budgets_user ON budgets(user_id);

    CREATE TABLE goals_v2 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT    NOT NULL,
        target_cents INTEGER NOT NULL CHECK (target_cents > 0),
        saved_cents  INTEGER NOT NULL DEFAULT 0,
        deadline     TEXT,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL,
        UNIQUE (user_id, name)
    );
    INSERT INTO goals_v2 (id, user_id, name, target_cents, saved_cents,
                          deadline, active, created_at)
    SELECT id, ${LEGACY_USER_ID}, name, target_cents, saved_cents,
           deadline, active, created_at
      FROM goals;
    DROP TABLE goals;
    ALTER TABLE goals_v2 RENAME TO goals;
    CREATE INDEX idx_goals_user ON goals(user_id, active);

    CREATE TABLE sent_alerts_v2 (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        month   TEXT NOT NULL,
        level   TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key, month, level)
    );
    INSERT INTO sent_alerts_v2 (user_id, key, month, level, sent_at)
    SELECT ${LEGACY_USER_ID}, key, month, level, sent_at FROM sent_alerts;
    DROP TABLE sent_alerts;
    ALTER TABLE sent_alerts_v2 RENAME TO sent_alerts;

    CREATE TABLE settings_v2 (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
    );
    INSERT INTO settings_v2 (user_id, key, value)
    SELECT ${LEGACY_USER_ID}, key, value FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_v2 RENAME TO settings;

    CREATE VIEW v_transactions AS
    SELECT
        t.id, t.user_id, t.type, t.amount_cents, t.description, t.date,
        t.note, t.source, t.installment_num, t.installment_total,
        t.installment_group, t.recurring_id, t.created_at, t.updated_at,
        t.category_id,
        COALESCE(c.name, 'Sem categoria') AS category,
        cp.name                           AS parent_category,
        c.emoji                           AS category_emoji,
        t.account_id,
        COALESCE(a.name, 'Sem conta')     AS account,
        a.type                            AS account_type,
        t.dest_account_id,
        ad.name                           AS dest_account
    FROM transactions t
    LEFT JOIN categories c  ON c.id  = t.category_id
    LEFT JOIN categories cp ON cp.id = c.parent_id
    LEFT JOIN accounts a    ON a.id  = t.account_id
    LEFT JOIN accounts ad   ON ad.id = t.dest_account_id;

    PRAGMA foreign_keys = ON;
    `,
  },
  {
    // "Due" and "paid" become different things.
    //
    // A fixed cost generates an occurrence when it falls due; the money only
    // leaves when the person pays it. `status` splits the two, and it defaults to
    // 'paid' precisely so that nothing else changes: an expense typed into the
    // chat is already paid by the time it is typed, and every existing row is
    // too. Only `recurring apply` ever writes 'pending'.
    //
    // `paid_at` is when it was settled, which is not the same as `date` (when it
    // was due). It stays NULL for a row that was born paid — `date` already
    // answers "when", and back-filling a timestamp we never observed would be
    // inventing data.
    //
    // Plain ADD COLUMNs here, not the table rebuild of migration 2: no UNIQUE
    // constraint changes, so SQLite can widen these tables in place.
    version: 3,
    sql: `
    ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'paid'
        CHECK (status IN ('paid','pending'));
    ALTER TABLE transactions ADD COLUMN paid_at TEXT;

    -- Debited automatically by the bank (rent on direct debit, a subscription on
    -- the card): the occurrence is posted already paid, because nobody has to do
    -- anything for that money to leave.
    ALTER TABLE recurring ADD COLUMN auto_debit INTEGER NOT NULL DEFAULT 0;

    -- "What do I still owe" reads by user + status and sorts by due date.
    CREATE INDEX idx_tx_user_status ON transactions(user_id, status, date);

    -- The failed-attempt counter moves out of \`users\` and into \`app_state\`.
    --
    -- Two reasons. It had to exist before the person did, so a wrong code from an
    -- unknown id created a permanent \`users\` row just to hold a number — junk
    -- rows that then showed up in \`auth users\`. And a per-id counter is not a
    -- limit on its own: the caller picks the id. A global counter lives here too,
    -- under 'failed_attempts_global', and trips for everybody at once.
    INSERT INTO app_state (key, value)
    SELECT 'failed_attempts:' || telegram_user_id, CAST(failed_attempts AS TEXT)
      FROM users WHERE failed_attempts > 0;
    INSERT OR IGNORE INTO app_state (key, value)
         VALUES ('failed_attempts_global', '0');
    ALTER TABLE users DROP COLUMN failed_attempts;

    DROP VIEW v_transactions;
    CREATE VIEW v_transactions AS
    SELECT
        t.id, t.user_id, t.type, t.amount_cents, t.description, t.date,
        t.status, t.paid_at,
        t.note, t.source, t.installment_num, t.installment_total,
        t.installment_group, t.recurring_id, t.created_at, t.updated_at,
        t.category_id,
        COALESCE(c.name, 'Sem categoria') AS category,
        cp.name                           AS parent_category,
        c.emoji                           AS category_emoji,
        t.account_id,
        COALESCE(a.name, 'Sem conta')     AS account,
        a.type                            AS account_type,
        t.dest_account_id,
        ad.name                           AS dest_account
    FROM transactions t
    LEFT JOIN categories c  ON c.id  = t.category_id
    LEFT JOIN categories cp ON cp.id = c.parent_id
    LEFT JOIN accounts a    ON a.id  = t.account_id
    LEFT JOIN accounts ad   ON ad.id = t.dest_account_id;
    `,
  },
  {
    // Per-person invites, so that letting somebody in and cutting somebody off are
    // two different acts.
    //
    // Before this there was one `TALLY_ACCESS_CODE` in the environment, typed by
    // both people and living there forever. Three problems it had: one person
    // could not be cut off without disturbing the other, whoever knew the string
    // could register further Telegram ids at any time, and the secret sat in the
    // environment of a process the agent spawns — so `env` would still show it
    // months later.
    //
    // An invite is single-use, expires on its own, and only its SHA-256 lands
    // here: `auth invite` prints the code once and nothing can print it again.
    // Once everybody has redeemed one, `TALLY_ACCESS_CODE` can be deleted and no
    // standing secret exists anywhere.
    //
    // What this does NOT change: the agent has a shell and this file is a file it
    // can open. Invites improve onboarding and revocation, not isolation — a
    // registered person can still reach the other's ledger by asking the bot to
    // run a command. See the header of this file.
    version: 4,
    sql: `
    CREATE TABLE invites (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        -- SHA-256 of the normalised code, never the code. UNIQUE, which is also
        -- the index the redemption lookup rides: it is a point query on this
        -- column and nothing else.
        code_hash           TEXT NOT NULL UNIQUE,
        -- Who it is for, in the owner's own words. Only he ever reads it, and it
        -- is what makes 'revoke the one I gave to X' answerable months later.
        label               TEXT,
        created_at          TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        -- Set together, in one conditional UPDATE, and that is what makes a
        -- second redemption of the same code impossible. See \`redeemInvite\`.
        redeemed_at         TEXT,
        redeemed_by_user_id INTEGER REFERENCES users(id),
        revoked_at          TEXT
    );

    -- 'which invite did this person come in through', which is what
    -- \`auth revoke --user\` reports. The code_hash lookup needs no index of its
    -- own: UNIQUE above already created one.
    CREATE INDEX idx_invites_redeemed_by ON invites(redeemed_by_user_id);
    `,
  },
];

/**
 * Starting taxonomy.
 *
 * The names are in Portuguese on purpose: they are data, not code. They show up
 * in every report the user reads and in the messages the bot sends, so they
 * follow the bot's language, not the codebase's.
 */
const SEED_CATEGORIES: readonly {
  name: string;
  emoji: string;
  type: CategoryType;
  children: readonly string[];
}[] = [
  { name: "Alimentação", emoji: "🍽️", type: "expense", children: ["Mercado", "Restaurante", "Delivery", "Padaria", "Café"] },
  { name: "Transporte", emoji: "🚗", type: "expense", children: ["Uber/99", "Combustível", "Estacionamento", "Transporte público", "Manutenção"] },
  { name: "Moradia", emoji: "🏠", type: "expense", children: ["Aluguel", "Condomínio", "Luz", "Água", "Gás", "Internet", "IPTU"] },
  { name: "Saúde", emoji: "💊", type: "expense", children: ["Farmácia", "Consulta", "Exame", "Plano de saúde", "Academia"] },
  { name: "Lazer", emoji: "🎉", type: "expense", children: ["Streaming", "Bar", "Cinema", "Viagem", "Jogos", "Eventos"] },
  { name: "Compras", emoji: "🛍️", type: "expense", children: ["Roupas", "Eletrônicos", "Casa", "Presentes"] },
  { name: "Educação", emoji: "📚", type: "expense", children: ["Curso", "Livros", "Mensalidade", "Certificação"] },
  { name: "Assinaturas", emoji: "🔁", type: "expense", children: ["Software", "Streaming", "Nuvem", "Telefonia"] },
  { name: "Serviços", emoji: "🔧", type: "expense", children: ["Cabeleireiro", "Lavanderia", "Reparos", "Assinatura profissional"] },
  { name: "Impostos e taxas", emoji: "🧾", type: "expense", children: ["Imposto", "Tarifa bancária", "Multa", "Juros"] },
  { name: "Pets", emoji: "🐾", type: "expense", children: ["Ração", "Veterinário", "Petshop"] },
  { name: "Família", emoji: "👨‍👩‍👧", type: "expense", children: ["Filhos", "Escola", "Mesada", "Ajuda familiar"] },
  { name: "Investimentos", emoji: "📈", type: "both", children: ["Aporte", "Resgate", "Dividendos"] },
  { name: "Dívidas", emoji: "💳", type: "expense", children: ["Fatura de cartão", "Empréstimo", "Financiamento"] },
  { name: "Outros", emoji: "❓", type: "both", children: [] },
  { name: "Salário", emoji: "💰", type: "income", children: ["Salário", "13º", "Férias", "Bônus"] },
  { name: "Renda extra", emoji: "💵", type: "income", children: ["Freelance", "Venda", "Aluguel recebido", "Reembolso", "Cashback"] },
];

export type Db = DatabaseSync;

/**
 * Opens the connection with the pragmas this bot needs.
 *
 * WAL because cron may read while a conversation writes; `foreign_keys` because
 * the schema's FKs only apply when switched on per connection.
 */
export function connect(path?: string): Db {
  const target = path ?? DEFAULT_DB;
  mkdirSync(dirname(resolve(target)), { recursive: true });

  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 15000");
  return db;
}

/**
 * Runs `fn` inside a transaction, rolling back on error.
 *
 * `mode` is `DEFERRED` (SQLite's default) unless a caller says otherwise: the
 * write lock is taken at the first write, which is right for everything that
 * reads its own data. `IMMEDIATE` takes the write lock at `BEGIN`, and exists for
 * read-then-conditionally-write sequences that must not interleave — a second
 * connection waits (up to `busy_timeout`) and then reads what the first one
 * committed, instead of reading a stale snapshot and failing at COMMIT.
 * `redeemInvite` is the one that needs it.
 */
export function transaction<T>(
  db: Db,
  fn: () => T,
  mode: "DEFERRED" | "IMMEDIATE" = "DEFERRED",
): T {
  db.exec(mode === "IMMEDIATE" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function currentVersion(db: Db): number {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  return Number(row?.v ?? 0);
}

/** Applies pending migrations. Returns the versions applied. */
export function migrate(db: Db): number[] {
  const current = currentVersion(db);
  const applied: number[] = [];
  for (const { version, sql } of MIGRATIONS) {
    if (version <= current) continue;
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      version,
      now(),
    );
    applied.push(version);
  }
  return applied;
}

export interface SeedResult {
  categories: number;
  subcategories: number;
  accounts: number;
}

/**
 * Populates one user's categories, default account and initial settings.
 *
 * Runs at registration, not at `init`: the taxonomy is per user now, so there is
 * nothing global left to seed. Only inserts what is missing, so it never
 * overrides something the user renamed or deleted.
 */
export function seedUser(db: Db, userId: number): SeedResult {
  const created: SeedResult = { categories: 0, subcategories: 0, accounts: 0 };

  transaction(db, () => {
    for (const { name, emoji, type, children } of SEED_CATEGORIES) {
      const existing = db
        .prepare(
          "SELECT id FROM categories WHERE user_id = ? AND parent_id IS NULL AND name = ?",
        )
        .get(userId, name) as { id: number } | undefined;

      let parentId: number;
      if (existing) {
        parentId = existing.id;
      } else {
        const info = db
          .prepare(
            "INSERT INTO categories (user_id, name, parent_id, type, emoji) " +
              "VALUES (?, ?, NULL, ?, ?)",
          )
          .run(userId, name, type, emoji);
        parentId = Number(info.lastInsertRowid);
        created.categories++;
      }

      for (const child of children) {
        const present = db
          .prepare(
            "SELECT 1 FROM categories WHERE user_id = ? AND name = ? AND parent_id = ?",
          )
          .get(userId, child, parentId);
        if (!present) {
          db.prepare(
            "INSERT INTO categories (user_id, name, parent_id, type, emoji) " +
              "VALUES (?, ?, ?, ?, NULL)",
          ).run(userId, child, parentId, type);
          created.subcategories++;
        }
      }
    }

    // One default account, so logging an expense works with no setup at all.
    if (!db.prepare("SELECT 1 FROM accounts WHERE user_id = ? LIMIT 1").get(userId)) {
      db.prepare(
        "INSERT INTO accounts (user_id, name, type, created_at) VALUES (?, ?, ?, ?)",
      ).run(userId, "Carteira", "cash", now());
      created.accounts++;
    }

    for (const [key, value] of [
      ["currency", "BRL"],
      ["timezone", TZ],
      ["default_account", "Carteira"],
    ]) {
      db.prepare(
        "INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
      ).run(userId, key, value);
    }
  });

  return created;
}

/**
 * Creates or migrates the schema. Nothing else.
 *
 * Seeding used to happen here; it moved to `auth login`, because categories,
 * accounts and settings belong to a user and there is no user yet at this point.
 */
export function init(path?: string) {
  const db = connect(path);
  try {
    const applied = migrate(db);
    return {
      database: path ?? DEFAULT_DB,
      schema_version: currentVersion(db),
      migrations_applied: applied,
    };
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

export interface UserRow {
  id: number;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  display_name: string | null;
  authenticated_at: string | null;
  auth_epoch: number;
  active: number;
  created_at: string;
}

/** The placeholder id migration 2 parks pre-multi-user rows under. */
export const LEGACY_TELEGRAM_ID = "legacy";

/**
 * The shared access code, read from the environment.
 *
 * Deliberately not in the database (a backup would carry it) and not in the
 * prompt (the model would repeat it). It is never returned, logged or echoed
 * anywhere — including in this module's error messages.
 *
 * It is now the *fallback* mode: an invite is checked first. Keeping it is not
 * legacy weight — a working install is documented around this variable, and the
 * shared code stays the simple way to onboard one more person without minting
 * anything. But it is also the standing secret invites exist to remove, so once
 * everybody has redeemed one it can be deleted from the environment; see
 * `sharedCodeConfigured`.
 */
function configuredCode(): string {
  const code = process.env.TALLY_ACCESS_CODE;
  if (!code || !code.trim()) {
    throw new FinError(
      "O acesso ainda não foi configurado no servidor. Avise o Geovane.",
    );
  }
  return code;
}

/**
 * Whether the candidate matches the configured access code.
 *
 * Both sides are hashed before the comparison so the buffers are always 32
 * bytes: `timingSafeEqual` throws on different lengths, and answering "wrong
 * length" faster than "wrong code" would leak how long the real code is.
 */
export function verifyAccessCode(candidate: string): boolean {
  const expected = createHash("sha256").update(configuredCode(), "utf8").digest();
  const given = createHash("sha256").update(String(candidate ?? ""), "utf8").digest();
  return timingSafeEqual(given, expected);
}

/**
 * Whether a shared access code exists in the environment at all.
 *
 * Its absence is the desired end state, not an error: with everybody registered
 * through an invite, deleting `TALLY_ACCESS_CODE` leaves no standing secret for
 * anything — including the agent's own `env` — to read. The caller uses this to
 * decide whether "no shared code" means "not configured yet" or "on purpose".
 */
export function sharedCodeConfigured(): boolean {
  const code = process.env.TALLY_ACCESS_CODE;
  return typeof code === "string" && code.trim() !== "";
}

/* -- Invites: one code per person, single use -------------------------------- */

/**
 * The alphabet an invite code is drawn from: 31 characters.
 *
 * No `0`/`O` and no `1`/`I`/`L`, because this code is *dictated in person* — the
 * whole point of an invite is that it never travels through the chat it protects.
 * A character somebody can mishear is a support conversation, and worse, a wrong
 * code spends one of the five attempts before the lockout.
 */
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * 12 characters, printed as `7K2M-QX9P-4TVB`.
 *
 * 12 × log2(31) ≈ **59 bits**, i.e. about 5.8 × 10¹⁷ codes. Guessing is hopeless
 * twice over: the existing lockout stops everybody after 20 wrong codes in total,
 * so an attacker gets 20 tries at a 1-in-10¹⁷ chance, and the invite expires
 * anyway. It is short enough to read aloud and long enough that nothing about the
 * search space matters.
 */
export const INVITE_CODE_LENGTH = 12;
const INVITE_GROUP_SIZE = 4;

/** Long enough to hand over in person, short enough to be worth expiring. */
export const DEFAULT_INVITE_HOURS = 48;
/** A year. Past this an "invite" is just a second shared code with extra steps. */
export const MAX_INVITE_HOURS = 24 * 365;

/** A fresh code, grouped for a human to read out. Never stored — only its hash. */
export function generateInviteCode(): string {
  // Rejection sampling. 256 is not a multiple of 31, so folding every byte with
  // `%` would make the first nine characters of the alphabet slightly likelier;
  // discarding the tail keeps the distribution flat. The cost is ~3% of the bytes.
  const limit = Math.floor(256 / INVITE_ALPHABET.length) * INVITE_ALPHABET.length;
  const chars: string[] = [];
  while (chars.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
      if (byte >= limit) continue;
      chars.push(INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
      if (chars.length === INVITE_CODE_LENGTH) break;
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < INVITE_CODE_LENGTH; i += INVITE_GROUP_SIZE) {
    groups.push(chars.slice(i, i + INVITE_GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

/**
 * The form that gets hashed: upper-case, letters and digits only.
 *
 * Somebody who was told `7K2M-QX9P-4TVB` will type `7k2m qx9p 4tvb`, or paste it
 * with a stray dash. All of those are the same code, so the separators and the
 * case are dropped before hashing rather than being rejected — a person retyping
 * a code they heard correctly must not be told they got it wrong.
 */
export function normalizeInviteCode(raw: string): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

/** SHA-256 of the normalised code, hex. The only form of a code we ever store. */
export function hashInviteCode(raw: string): string {
  return createHash("sha256").update(normalizeInviteCode(raw), "utf8").digest("hex");
}

export type InviteStatus = "pending" | "redeemed" | "expired" | "revoked";

export interface InviteRow {
  id: number;
  code_hash: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by_user_id: number | null;
  revoked_at: string | null;
}

/** An invite as the operator sees it. No `code_hash`, and never the code. */
export interface InviteView {
  id: number;
  label: string | null;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  /** The Telegram id that used it, when it was used. */
  redeemed_by: string | null;
  revoked_at: string | null;
}

/**
 * The status is derived, never stored — three nullable columns already say it.
 *
 * `redeemed` wins over `revoked` because it records what actually happened: a
 * redeemed invite cannot be revoked afterwards (`revokeInvite` refuses and points
 * at `auth revoke --user`, which is the thing that removes a person's access).
 */
export function inviteStatus(row: InviteRow, at: string = now()): InviteStatus {
  if (row.redeemed_at) return "redeemed";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= at) return "expired";
  return "pending";
}

function inviteView(
  row: InviteRow & { redeemed_by?: string | null },
  at: string = now(),
): InviteView {
  return {
    id: row.id,
    label: row.label,
    status: inviteStatus(row, at),
    created_at: row.created_at,
    expires_at: row.expires_at,
    redeemed_at: row.redeemed_at,
    redeemed_by: row.redeemed_by ?? null,
    revoked_at: row.revoked_at,
  };
}

export interface MintedInvite {
  invite: InviteView;
  /** The plaintext code. The caller prints it once; nothing can print it again. */
  code: string;
}

/** Mints an invite, storing only its hash. */
export function createInvite(
  db: Db,
  label: string | null,
  hours: number = DEFAULT_INVITE_HOURS,
): MintedInvite {
  const created = now();
  const expires = addHours(created, hours);

  // A collision at 59 bits is not a thing that happens, but the column is UNIQUE
  // and retrying costs two lines — better than surfacing a constraint error.
  for (let attempt = 0; ; attempt++) {
    const code = generateInviteCode();
    try {
      const info = db
        .prepare(
          "INSERT INTO invites (code_hash, label, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(hashInviteCode(code), label, created, expires);
      const row = db
        .prepare("SELECT * FROM invites WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as InviteRow;
      return { invite: inviteView(row, created), code };
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
}

/** Every invite, newest last, with the Telegram id of whoever redeemed it. */
export function listInvites(db: Db, at: string = now()): InviteView[] {
  const rows = db
    .prepare(
      "SELECT i.*, u.telegram_user_id AS redeemed_by FROM invites i " +
        "LEFT JOIN users u ON u.id = i.redeemed_by_user_id ORDER BY i.id",
    )
    .all() as (InviteRow & { redeemed_by: string | null })[];
  return rows.map((row) => inviteView(row, at));
}

export interface RevokedInvite {
  invite: InviteView;
  /** True when it was already revoked, so the caller can say so instead of lying. */
  already_revoked: boolean;
}

/**
 * Kills an invite that has not been used.
 *
 * Refuses a redeemed one on purpose: revoking it would look like it removed
 * somebody's access, and it would not. That is `revokeUser`.
 *
 * `IMMEDIATE` for the same reason as `redeemInvite`, on the other side of the same
 * race: the operator typing this at the very moment somebody redeems the code must
 * not be told "revoked" about an invite that in fact got used. Whoever takes the
 * write lock first wins, and the other one sees the truth.
 */
export function revokeInvite(db: Db, id: number, at: string = now()): RevokedInvite {
  return transaction(
    db,
    () => {
      const row = db
        .prepare(
          "SELECT i.*, u.telegram_user_id AS redeemed_by FROM invites i " +
            "LEFT JOIN users u ON u.id = i.redeemed_by_user_id WHERE i.id = ?",
        )
        .get(id) as (InviteRow & { redeemed_by: string | null }) | undefined;
      if (!row) {
        throw new FinError(
          `Não achei o convite #${id}. Rode \`auth invites\` para ver a lista.`,
        );
      }

      if (row.redeemed_at) {
        throw new FinError(
          `O convite #${id} já foi usado${row.redeemed_by ? ` por ${row.redeemed_by}` : ""}. ` +
            "Revogar o convite não tira o acesso de ninguém — para isso use " +
            "`auth revoke --user <id do Telegram>`.",
        );
      }

      if (row.revoked_at) return { invite: inviteView(row, at), already_revoked: true };

      db.prepare(
        "UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL " +
          "AND redeemed_at IS NULL",
      ).run(at, id);
      return {
        invite: inviteView({ ...row, revoked_at: at }, at),
        already_revoked: false,
      };
    },
    "IMMEDIATE",
  );
}

/** Whether any invite was ever minted, i.e. whether this install uses them. */
export function anyInvites(db: Db): boolean {
  return db.prepare("SELECT 1 FROM invites LIMIT 1").get() !== undefined;
}

/**
 * Consumes the invite this code belongs to, and registers the redeemer.
 *
 * Returns `undefined` when the code matches no *usable* invite — unknown, expired,
 * revoked and already-redeemed are all the same answer, so the caller reports a
 * plain wrong code and probing tells an outsider nothing about which invites
 * exist.
 *
 * Atomicity, which is the whole reason this function exists instead of two calls:
 *
 * - `BEGIN IMMEDIATE` takes the write lock up front. A second process redeeming
 *   the same code waits on it (`busy_timeout`), and when it gets in it reads the
 *   row *after* the first commit — so it sees `redeemed_at` set and simply misses.
 *   With a deferred transaction it would read the stale snapshot and blow up at
 *   COMMIT with a raw SQLite error instead.
 * - The UPDATE repeats every condition in its WHERE clause and requires exactly
 *   one changed row. Belt and braces against any path that gets here without the
 *   lock.
 * - `register` runs *inside* the transaction. If the UPDATE finds nothing to
 *   consume, the rollback takes the user row with it — a redemption that lost the
 *   race must not leave somebody authenticated — and this returns `undefined`, so
 *   the loser is told the code is wrong. Which it is: by then it is spent.
 */
export function redeemInvite(
  db: Db,
  rawCode: string,
  register: () => number,
  at: string = now(),
): InviteView | undefined {
  const normalized = normalizeInviteCode(rawCode);
  if (!normalized) return undefined;
  const hash = hashInviteCode(normalized);

  try {
    return runRedemption(db, hash, register, at);
  } catch (e) {
    if (e instanceof InviteRaceLost) return undefined;
    throw e;
  }
}

function runRedemption(
  db: Db,
  hash: string,
  register: () => number,
  at: string,
): InviteView | undefined {
  return transaction(
    db,
    () => {
      const row = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hash) as
        | InviteRow
        | undefined;
      if (!row || inviteStatus(row, at) !== "pending") return undefined;

      const userId = register();
      const info = db
        .prepare(
          "UPDATE invites SET redeemed_at = ?, redeemed_by_user_id = ? " +
            " WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL " +
            "   AND expires_at > ?",
        )
        .run(at, userId, row.id, at);

      if (Number(info.changes) !== 1) {
        // Unwinds `register()` with it: the rollback is the point.
        throw new InviteRaceLost();
      }

      return inviteView({ ...row, redeemed_at: at, redeemed_by_user_id: userId }, at);
    },
    "IMMEDIATE",
  );
}

/** Internal: the loser of a simultaneous redemption. Never reaches the user. */
class InviteRaceLost extends Error {}

/* -- Per-person revocation --------------------------------------------------- */

export interface RevokeUserResult {
  telegram_user_id: string;
  user_id: number;
  /** Whether that person had a live session at the moment it was revoked. */
  was_current: boolean;
  /** Proof that nothing was deleted: their rows are still counted here. */
  transactions_preserved: number;
  /** The invite they came in through, when they came in through one. */
  invite_id: number | null;
}

/**
 * Cuts one person off, and nobody else.
 *
 * The scalpel to `logout-all`'s panic button: that one bumps the global epoch and
 * everybody re-authenticates, this one touches a single row.
 *
 * The mechanism is the `active` flag that migration 2 already added and
 * `isSessionCurrent` already checks — so `requireUser` refuses this person from the
 * next command on, with the same answer an unknown id gets. No new concept, no
 * second place to look.
 *
 * **Their data is never deleted**, same principle as `logout-all`: the ledger is
 * theirs, and revoking access is not a reason to destroy it. They come back by
 * redeeming a new invite, which flips `active` on again and finds everything where
 * they left it.
 */
export function revokeUser(
  db: Db,
  telegramUserId: string,
  epoch: number,
): RevokeUserResult {
  const user = findUser(db, telegramUserId);
  if (!user) {
    throw new FinError(
      `Não achei ninguém com o id ${telegramUserId}. Rode \`auth users\` para ver ` +
        "quem está cadastrado.",
    );
  }

  const transactions = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?")
    .get(user.id) as { n: number };
  const invite = db
    .prepare(
      "SELECT id FROM invites WHERE redeemed_by_user_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(user.id) as { id: number } | undefined;

  db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(user.id);

  return {
    telegram_user_id: user.telegram_user_id,
    user_id: user.id,
    was_current: isSessionCurrent(user, epoch),
    transactions_preserved: Number(transactions.n),
    invite_id: invite ? invite.id : null,
  };
}

/* -- app_state: the global key/value the auth state lives in ---------------- */

function appState(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setAppState(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_state (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** The global epoch. Every session below it is void. */
export function globalAuthEpoch(db: Db): number {
  return Number(appState(db, "auth_epoch") ?? 0);
}

export function setGlobalAuthEpoch(db: Db, epoch: number): void {
  setAppState(db, "auth_epoch", String(epoch));
}

const GLOBAL_ATTEMPTS_KEY = "failed_attempts_global";
const attemptsKey = (telegramUserId: string) =>
  `failed_attempts:${String(telegramUserId)}`;

/** Wrong codes recorded against one Telegram id. */
export function failedAttempts(db: Db, telegramUserId: string): number {
  return Number(appState(db, attemptsKey(telegramUserId)) ?? 0);
}

/** Wrong codes recorded against every id together. */
export function globalFailedAttempts(db: Db): number {
  return Number(appState(db, GLOBAL_ATTEMPTS_KEY) ?? 0);
}

/**
 * Counts one wrong code, per id and globally.
 *
 * Both counters live in `app_state`, so a wrong code from an id nobody has ever
 * seen leaves no `users` row behind: guessing at ids no longer populates the
 * user list, and the id itself is all the key that is needed.
 */
export function recordFailedAttempt(
  db: Db,
  telegramUserId: string,
): { attempts: number; global_attempts: number } {
  const attempts = failedAttempts(db, telegramUserId) + 1;
  const globalAttempts = globalFailedAttempts(db) + 1;
  transaction(db, () => {
    setAppState(db, attemptsKey(telegramUserId), String(attempts));
    setAppState(db, GLOBAL_ATTEMPTS_KEY, String(globalAttempts));
  });
  return { attempts, global_attempts: globalAttempts };
}

/**
 * Lifts the lock: clears this id's counter and the global one with it.
 *
 * The global counter has to go too — while it is tripped nobody can log in at
 * all, so leaving it set would mean unlocking one person and locking everyone.
 * Called by `auth unlock` and by a login that got the code right (knowing the
 * code is not something a guesser can do to reset the counters).
 */
export function clearFailedAttempts(
  db: Db,
  telegramUserId: string,
): { attempts_cleared: number; global_cleared: number } {
  const attempts = failedAttempts(db, telegramUserId);
  const globalAttempts = globalFailedAttempts(db);
  transaction(db, () => {
    db.prepare("DELETE FROM app_state WHERE key = ?").run(attemptsKey(telegramUserId));
    setAppState(db, GLOBAL_ATTEMPTS_KEY, "0");
  });
  return { attempts_cleared: attempts, global_cleared: globalAttempts };
}

export function findUser(db: Db, telegramUserId: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
    .get(String(telegramUserId)) as UserRow | undefined;
}

export function listUsers(db: Db): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[];
}

/**
 * Whether this user may act right now.
 *
 * `authenticated_at` has to be set — the legacy placeholder sits at epoch 0 with
 * no timestamp precisely so it does not slip through while the global epoch is
 * still 0 — and the session must not predate the last `logout-all`.
 */
export function isSessionCurrent(user: UserRow, epoch: number): boolean {
  return (
    user.active === 1 && user.authenticated_at !== null && user.auth_epoch >= epoch
  );
}

/**
 * Whether this id may still try a code.
 *
 * Two ways to be locked: this id burned its five attempts, or the ids together
 * burned twenty. Keyed by Telegram id rather than by `users` row, because the
 * counter has to exist for ids that have no row.
 */
export function isLockedOut(db: Db, telegramUserId: string): boolean {
  return (
    globalFailedAttempts(db) >= MAX_GLOBAL_FAILED_ATTEMPTS ||
    failedAttempts(db, telegramUserId) >= MAX_FAILED_ATTEMPTS
  );
}

/** Whether everybody is locked out, whatever id they claim. */
export function isGloballyLocked(db: Db): boolean {
  return globalFailedAttempts(db) >= MAX_GLOBAL_FAILED_ATTEMPTS;
}

/* -- The legacy ledger ------------------------------------------------------ */

/** Every table keyed by `user_id`, ordered so deletes respect the foreign keys. */
const PER_USER_TABLES: readonly string[] = [
  "transactions",
  "recurring",
  "budgets",
  "goals",
  "tags",
  "sent_alerts",
  "settings",
  "categories",
  "accounts",
];

export interface AdoptLegacyResult {
  telegram_user_id: string;
  user_id: number;
  created_user: boolean;
  moved: Record<string, number>;
  discarded: number;
}

/**
 * Hands the pre-multi-user rows to a real person.
 *
 * Migration 2 parked everything that already existed under a `legacy`
 * placeholder. Nothing could ever claim it: logging in creates a *new* user with
 * an empty ledger, and the placeholder itself can never authenticate. This is the
 * step that closes that gap, and it is deliberately not something a chat turn can
 * trigger — see `requireOperator` in `fin.ts`.
 *
 * The target must not already have transactions of its own. Two real histories
 * cannot be merged safely: `accounts`, `categories`, `tags`, `goals` and
 * `settings` are all UNIQUE per user and name, so the merge would have to invent
 * renamed duplicates of somebody's taxonomy. Refusing is the honest answer.
 *
 * A target that has only ever been seeded (categories, "Carteira", settings, and
 * no transactions) is the normal case, and those seeded rows are dropped so the
 * adopted names have somewhere to land. They come back on the next login, which
 * fills in whatever the old ledger was missing.
 */
export function adoptLegacy(db: Db, telegramUserId: string): AdoptLegacyResult {
  const legacy = findUser(db, LEGACY_TELEGRAM_ID);
  if (!legacy) {
    throw new FinError(
      "Não há histórico antigo para adotar: nenhum usuário 'legacy' neste banco.",
    );
  }

  return transaction(db, () => {
    const existing = findUser(db, telegramUserId);
    let userId: number;
    let discarded = 0;

    if (existing) {
      const own = db
        .prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?")
        .get(existing.id) as { n: number };
      if (Number(own.n) > 0) {
        throw new FinError(
          `O usuário ${telegramUserId} já tem lançamentos próprios, então não vou ` +
            "juntar dois históricos num só. Adote o histórico antigo em uma conta " +
            "sem lançamentos.",
        );
      }
      userId = existing.id;
      // Only seed data can be here (no transactions), and it would collide with
      // the adopted names on every UNIQUE (user_id, name).
      for (const table of PER_USER_TABLES) {
        discarded += Number(
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId).changes,
        );
      }
    } else {
      // Unauthenticated on purpose: adopting the rows does not let anybody in.
      // That person still types the code once, and the login finds the history
      // already waiting.
      const info = db
        .prepare(
          "INSERT INTO users (telegram_user_id, telegram_chat_id, display_name," +
            " authenticated_at, auth_epoch, active, created_at)" +
            " VALUES (?, NULL, ?, NULL, 0, 1, ?)",
        )
        .run(telegramUserId, legacy.display_name, now());
      userId = Number(info.lastInsertRowid);
    }

    const moved: Record<string, number> = {};
    for (const table of PER_USER_TABLES) {
      moved[table] = Number(
        db
          .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
          .run(userId, legacy.id).changes,
      );
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(legacy.id);

    return {
      telegram_user_id: telegramUserId,
      user_id: userId,
      created_user: existing === undefined,
      moved,
      discarded,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Per-user data access                                                       */
/* -------------------------------------------------------------------------- */

export function getSetting(
  db: Db,
  userId: number,
  key: string,
  fallback?: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: Db, userId: number, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
  ).run(userId, key, value);
}

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
}

/**
 * Finds a category by name, tolerating accents, case and plurals.
 *
 * Matches subcategories first (more specific: "Delivery" before "Food"), then
 * roots, then by containment. With `create`, files it under "Other" rather than
 * failing — losing a transaction because the category did not exist would be
 * worse than gaining one extra category.
 */
export function resolveCategory(
  db: Db,
  userId: number,
  name?: string | null,
  create = false,
): number | null {
  if (!name || !String(name).trim()) return null;

  const target = normalize(String(name));
  const rows = db
    .prepare("SELECT id, name, parent_id FROM categories WHERE user_id = ? AND active = 1")
    .all(userId) as CategoryRow[];

  const exact = rows.filter((r) => normalize(r.name) === target);
  if (exact.length) {
    exact.sort((a, b) => (a.parent_id === null ? 1 : 0) - (b.parent_id === null ? 1 : 0));
    return exact[0].id;
  }

  const variants = new Set([target, target.replace(/s$/, ""), `${target}s`]);
  for (const r of rows) {
    if (variants.has(normalize(r.name))) return r.id;
  }

  const partial = rows.filter((r) => {
    const n = normalize(r.name);
    return n.includes(target) || target.includes(n);
  });
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    partial.sort((a, b) => {
      const leaf = (a.parent_id === null ? 1 : 0) - (b.parent_id === null ? 1 : 0);
      return leaf !== 0 ? leaf : a.name.length - b.name.length;
    });
    return partial[0].id;
  }

  if (create) {
    const parent = db
      .prepare(
        "SELECT id FROM categories WHERE user_id = ? AND name = 'Outros' AND parent_id IS NULL",
      )
      .get(userId) as { id: number } | undefined;
    const info = db
      .prepare(
        "INSERT INTO categories (user_id, name, parent_id, type) VALUES (?, ?, ?, 'both')",
      )
      .run(userId, String(name).trim().slice(0, 60), parent ? parent.id : null);
    return Number(info.lastInsertRowid);
  }

  throw new FinError(
    `Categoria ${JSON.stringify(name)} não existe. Rode \`category list\` para ver as disponíveis.`,
  );
}

/** Finds an account by name; with no name, falls back to the default account. */
export function resolveAccount(
  db: Db,
  userId: number,
  name?: string | null,
  useDefault = true,
): number | null {
  if (!name || !String(name).trim()) {
    if (!useDefault) return null;
    const fallback = getSetting(db, userId, "default_account", "Carteira")!;
    const row = db
      .prepare("SELECT id FROM accounts WHERE user_id = ? AND name = ? AND active = 1")
      .get(userId, fallback) as { id: number } | undefined;
    if (row) return row.id;
    const any = db
      .prepare("SELECT id FROM accounts WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1")
      .get(userId) as { id: number } | undefined;
    return any ? any.id : null;
  }

  const target = normalize(String(name));
  const rows = db
    .prepare("SELECT id, name FROM accounts WHERE user_id = ? AND active = 1")
    .all(userId) as {
    id: number;
    name: string;
  }[];

  for (const r of rows) {
    if (normalize(r.name) === target) return r.id;
  }

  const partial = rows.filter((r) => {
    const n = normalize(r.name);
    return n.includes(target) || target.includes(n);
  });
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    throw new FinError(
      `Mais de uma conta casa com ${JSON.stringify(name)}: ` +
        `${partial.map((r) => r.name).join(", ")}. Seja específico.`,
    );
  }

  throw new FinError(
    `Conta ${JSON.stringify(name)} não existe. Rode \`account list\`, ou crie com \`account add\`.`,
  );
}

/** `Food > Delivery`, for display. */
export function fullCategoryName(
  db: Db,
  userId: number,
  categoryId?: number | null,
): string {
  if (!categoryId) return "Sem categoria";
  const row = db
    .prepare(
      "SELECT c.name AS name, p.name AS parent FROM categories c " +
        "LEFT JOIN categories p ON p.id = c.parent_id " +
        "WHERE c.id = ? AND c.user_id = ?",
    )
    .get(categoryId, userId) as { name: string; parent: string | null } | undefined;
  if (!row) return "Sem categoria";
  return row.parent ? `${row.parent} > ${row.name}` : row.name;
}

/**
 * A category together with its subcategories.
 *
 * Filtering by "Food" has to include what was logged under "Delivery", or a
 * budget on the parent would never add up to the sum of its parts.
 */
export function categoryAndChildrenIds(
  db: Db,
  userId: number,
  categoryId: number,
): number[] {
  const children = db
    .prepare("SELECT id FROM categories WHERE user_id = ? AND parent_id = ?")
    .all(userId, categoryId) as { id: number }[];
  return [categoryId, ...children.map((r) => r.id)];
}

export function tagsOf(db: Db, userId: number, transactionId: number): string[] {
  const rows = db
    .prepare(
      "SELECT t.name FROM tags t JOIN transaction_tags tt ON tt.tag_id = t.id " +
        "WHERE tt.transaction_id = ? AND t.user_id = ? ORDER BY t.name",
    )
    .all(transactionId, userId) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Replaces a transaction's tags. */
export function applyTags(
  db: Db,
  userId: number,
  transactionId: number,
  tags: string[],
): void {
  // The callers already checked ownership; checking again here is cheap and this
  // is the one function that writes through a join table, where a wrong id would
  // be invisible.
  const owned = db
    .prepare("SELECT 1 FROM transactions WHERE id = ? AND user_id = ?")
    .get(transactionId, userId);
  if (!owned) throw new FinError(`Não achei o lançamento #${transactionId}.`);

  transaction(db, () => {
    db.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").run(transactionId);
    for (const tag of tags) {
      const name = String(tag).trim().replace(/^#/, "");
      if (!name) continue;
      db.prepare("INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)").run(
        userId,
        name,
      );
      const row = db
        .prepare("SELECT id FROM tags WHERE user_id = ? AND name = ?")
        .get(userId, name) as { id: number };
      db.prepare(
        "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
      ).run(transactionId, row.id);
    }
  });
}

export interface TransactionRow {
  id: number;
  user_id: number;
  type: TransactionType;
  amount_cents: number;
  description: string;
  date: string;
  status: TransactionStatus;
  paid_at: string | null;
  note: string | null;
  source: string;
  installment_num: number | null;
  installment_total: number | null;
  installment_group: string | null;
  recurring_id: number | null;
  created_at: string;
  updated_at: string;
  category_id: number | null;
  category: string;
  parent_category: string | null;
  category_emoji: string | null;
  account_id: number | null;
  account: string;
  account_type: AccountType | null;
  dest_account_id: number | null;
  dest_account: string | null;
}

export interface TransactionOut extends TransactionRow {
  amount: number;
  amount_fmt: string;
  tags: string[];
  full_category: string;
  installment?: string;
}

/** A view row turned into the object the agent reads as JSON. */
export function serializeTransaction(
  db: Db,
  userId: number,
  row: TransactionRow,
): TransactionOut {
  const out: TransactionOut = {
    ...row,
    amount: row.amount_cents / 100,
    amount_fmt: formatMoney(row.amount_cents),
    tags: tagsOf(db, userId, row.id),
    full_category: row.parent_category
      ? `${row.parent_category} > ${row.category}`
      : row.category,
  };
  if (row.installment_total) {
    out.installment = `${row.installment_num}/${row.installment_total}`;
  }
  return out;
}
