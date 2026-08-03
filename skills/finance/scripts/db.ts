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
 *   to run on every boot and applies only what is missing.
 *
 * - Zero dependencies: `node:sqlite` is built in, so there is no `node_modules`,
 *   no build step and no native module to compile.
 *
 * Language split, applied throughout the codebase: identifiers, comments, table
 * and column names, and JSON keys are English. Anything the user ever reads is
 * Portuguese — `FinError` messages (the agent relays them into the chat),
 * category names, period labels and report text. When in doubt, ask whether the
 * string can reach Telegram.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Cents = number & { readonly __brand: unique symbol };

export type TransactionType = "expense" | "income" | "transfer";
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
export const ACCOUNT_TYPES: readonly AccountType[] = [
  "checking",
  "card",
  "cash",
  "savings",
  "investment",
  "voucher",
];

export const DEFAULT_DB = process.env.TALLY_DB ?? "/opt/data/finance/tally.db";

export const CURRENT_SCHEMA_VERSION = 1;

const TZ = "America/Sao_Paulo";

/**
 * An expected error whose message is safe to show the end user.
 *
 * The CLI turns this into `{"ok": false, "error": "..."}` and the agent relays
 * the text to Telegram. That is why these messages talk about money rather than
 * about SQL.
 */
export class FinError extends Error {}

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

/** ISO timestamp with the São Paulo offset, for the audit columns. */
export function now(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}-03:00`;
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

  if (total === 0) throw new FinError("O valor precisa ser maior que zero.");
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

/** Runs `fn` inside a transaction, rolling back on error. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
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
 * Populates categories, the default account and initial settings.
 *
 * Only inserts what is missing, so it never overrides something you renamed or
 * deleted.
 */
export function seed(db: Db): SeedResult {
  const created: SeedResult = { categories: 0, subcategories: 0, accounts: 0 };

  transaction(db, () => {
    for (const { name, emoji, type, children } of SEED_CATEGORIES) {
      const existing = db
        .prepare("SELECT id FROM categories WHERE parent_id IS NULL AND name = ?")
        .get(name) as { id: number } | undefined;

      let parentId: number;
      if (existing) {
        parentId = existing.id;
      } else {
        const info = db
          .prepare(
            "INSERT INTO categories (name, parent_id, type, emoji) VALUES (?, NULL, ?, ?)",
          )
          .run(name, type, emoji);
        parentId = Number(info.lastInsertRowid);
        created.categories++;
      }

      for (const child of children) {
        const present = db
          .prepare("SELECT 1 FROM categories WHERE name = ? AND parent_id = ?")
          .get(child, parentId);
        if (!present) {
          db.prepare(
            "INSERT INTO categories (name, parent_id, type, emoji) VALUES (?, ?, ?, NULL)",
          ).run(child, parentId, type);
          created.subcategories++;
        }
      }
    }

    // One default account, so logging an expense works with no setup at all.
    if (!db.prepare("SELECT 1 FROM accounts LIMIT 1").get()) {
      db.prepare("INSERT INTO accounts (name, type, created_at) VALUES (?, ?, ?)").run(
        "Carteira",
        "cash",
        now(),
      );
      created.accounts++;
    }

    for (const [key, value] of [
      ["currency", "BRL"],
      ["timezone", TZ],
      ["default_account", "Carteira"],
    ]) {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
        key,
        value,
      );
    }
  });

  return created;
}

export function init(path?: string) {
  const db = connect(path);
  try {
    const applied = migrate(db);
    const seeded = seed(db);
    return {
      database: path ?? DEFAULT_DB,
      schema_version: currentVersion(db),
      migrations_applied: applied,
      seed: seeded,
    };
  } finally {
    db.close();
  }
}

export function getSetting(db: Db, key: string, fallback?: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
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
  name?: string | null,
  create = false,
): number | null {
  if (!name || !String(name).trim()) return null;

  const target = normalize(String(name));
  const rows = db
    .prepare("SELECT id, name, parent_id FROM categories WHERE active = 1")
    .all() as CategoryRow[];

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
      .prepare("SELECT id FROM categories WHERE name = 'Outros' AND parent_id IS NULL")
      .get() as { id: number } | undefined;
    const info = db
      .prepare("INSERT INTO categories (name, parent_id, type) VALUES (?, ?, 'both')")
      .run(String(name).trim().slice(0, 60), parent ? parent.id : null);
    return Number(info.lastInsertRowid);
  }

  throw new FinError(
    `Categoria ${JSON.stringify(name)} não existe. Rode \`category list\` para ver as disponíveis.`,
  );
}

/** Finds an account by name; with no name, falls back to the default account. */
export function resolveAccount(
  db: Db,
  name?: string | null,
  useDefault = true,
): number | null {
  if (!name || !String(name).trim()) {
    if (!useDefault) return null;
    const fallback = getSetting(db, "default_account", "Carteira")!;
    const row = db
      .prepare("SELECT id FROM accounts WHERE name = ? AND active = 1")
      .get(fallback) as { id: number } | undefined;
    if (row) return row.id;
    const any = db
      .prepare("SELECT id FROM accounts WHERE active = 1 ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    return any ? any.id : null;
  }

  const target = normalize(String(name));
  const rows = db.prepare("SELECT id, name FROM accounts WHERE active = 1").all() as {
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
export function fullCategoryName(db: Db, categoryId?: number | null): string {
  if (!categoryId) return "Sem categoria";
  const row = db
    .prepare(
      "SELECT c.name AS name, p.name AS parent FROM categories c " +
        "LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?",
    )
    .get(categoryId) as { name: string; parent: string | null } | undefined;
  if (!row) return "Sem categoria";
  return row.parent ? `${row.parent} > ${row.name}` : row.name;
}

/**
 * A category together with its subcategories.
 *
 * Filtering by "Food" has to include what was logged under "Delivery", or a
 * budget on the parent would never add up to the sum of its parts.
 */
export function categoryAndChildrenIds(db: Db, categoryId: number): number[] {
  const children = db
    .prepare("SELECT id FROM categories WHERE parent_id = ?")
    .all(categoryId) as { id: number }[];
  return [categoryId, ...children.map((r) => r.id)];
}

export function tagsOf(db: Db, transactionId: number): string[] {
  const rows = db
    .prepare(
      "SELECT t.name FROM tags t JOIN transaction_tags tt ON tt.tag_id = t.id " +
        "WHERE tt.transaction_id = ? ORDER BY t.name",
    )
    .all(transactionId) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Replaces a transaction's tags. */
export function applyTags(db: Db, transactionId: number, tags: string[]): void {
  transaction(db, () => {
    db.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").run(transactionId);
    for (const tag of tags) {
      const name = String(tag).trim().replace(/^#/, "");
      if (!name) continue;
      db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
      const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as {
        id: number;
      };
      db.prepare(
        "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
      ).run(transactionId, row.id);
    }
  });
}

export interface TransactionRow {
  id: number;
  type: TransactionType;
  amount_cents: number;
  description: string;
  date: string;
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
export function serializeTransaction(db: Db, row: TransactionRow): TransactionOut {
  const out: TransactionOut = {
    ...row,
    amount: row.amount_cents / 100,
    amount_fmt: formatMoney(row.amount_cents),
    tags: tagsOf(db, row.id),
    full_category: row.parent_category
      ? `${row.parent_category} > ${row.category}`
      : row.category,
  };
  if (row.installment_total) {
    out.installment = `${row.installment_num}/${row.installment_total}`;
  }
  return out;
}
