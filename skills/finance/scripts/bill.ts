#!/usr/bin/env node
/**
 * Credit-card statement cycles — the real "fatura", not the calendar month.
 *
 * `balance` reports a card's `month_bill_fmt`, which is everything spent on that
 * card inside the current calendar month. For a credit card that is simply the
 * wrong number: a purchase on 28/07 on a card that closes on the 25th is billed
 * in August, and paying the July bill will not settle it. This module turns
 * `accounts.closing_day` and `accounts.due_day` — present in the schema since
 * migration 1 and unused until now — into actual cycles. No schema change.
 *
 * The two conventions this file commits to, both of them arbitrary until someone
 * writes them down:
 *
 * 1. **A purchase made *on* the closing day belongs to the *next* statement.**
 *    That is what Brazilian issuers do (Nubank, Itaú and Bradesco all describe
 *    the closing day as the first day of the new cycle), and it is the reading
 *    that makes sense from the payer's side: the statement closes at some point
 *    during that day, and money spent on a bill that is being sealed right now
 *    would give you zero days of float. So a cycle runs from the previous
 *    closing date (inclusive) to the day *before* this closing date (inclusive),
 *    and `closing_date` itself is already the first day of the following cycle.
 *
 * 2. **A statement is named after the month it closes in**, and its due date
 *    falls in that same month when `due_day > closing_day`, in the month after
 *    when `due_day <= closing_day`. The comparison is on the raw configured
 *    days, before any clamping. Rationale: a card that closes on the 25th and
 *    pays on the 5th can only mean the 5th of the following month, while one
 *    that closes on the 5th and pays on the 20th means the same month. `due_day
 *    == closing_day` is read as the next month — a bill due the very day it
 *    closes is not a thing.
 *
 * A card with no `closing_day` configured falls back to calendar months rather
 * than failing, and every result carries `has_closing_day: false` so the caller
 * can tell the user that the card has no closing day registered.
 *
 * CLI, for standalone use:
 *
 *     node bill.ts --db <path> --user-id <n> [--account <name>]
 *                  [--statement <open|last|next|YYYY-MM>] [--json]
 *
 * `--user-id` is the internal `users.id`, never a Telegram id: identity
 * resolution and authentication belong to `fin.ts`, and this module is called
 * from an already-authenticated context. It still filters `user_id` in every
 * single query, because two people share this database.
 *
 * Output: `--json` prints the full `{"ok": true, …}` envelope that the rest of
 * the CLI uses; without it, a success prints just the Portuguese `text`, which
 * is what makes the command usable by hand. A failure always prints
 * `{"ok": false, "error": "<Portuguese>"}`. Exit 0 on success, 1 on failure.
 *
 * Language split, as everywhere else here: identifiers, comments and JSON keys
 * in English; every string the user can read in Portuguese. See `db.ts`.
 */

import { parseArgs } from "node:util";

import {
  CURRENT_SCHEMA_VERSION,
  FinError,
  addDays,
  connect,
  currentVersion,
  formatMoney,
  isValidMonth,
  lastDayOfMonth,
  migrate,
  monthOf,
  normalize,
  parseDate,
  today,
  type Db,
} from "./db.ts";

type Args = Record<string, string | boolean | undefined>;
type Output = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Calendar helpers                                                           */
/* -------------------------------------------------------------------------- */

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * `iso()` with the day clamped to the length of the month.
 *
 * The same rule `addMonths` applies to instalments: a card that closes on the
 * 31st closes on the 28th in February and on the 30th in April. Clamping, not
 * overflowing into the next month — overflowing would make two statements close
 * on the same date.
 */
function clampedDate(year: number, month: number, day: number): string {
  return iso(year, month, Math.min(day, lastDayOfMonth(year, month)));
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function splitMonth(month: string): { year: number; month: number } {
  if (!isValidMonth(month)) {
    throw new FinError(`Fatura ${JSON.stringify(month)} inválida. Use o formato YYYY-MM.`);
  }
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

const monthKey = (year: number, month: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

/** `2026-08` -> `08/2026`, the way a Brazilian reads a statement's name. */
const monthLabel = (month: string): string => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

/**
 * `2026-08-03` -> `03/08`, with the year only when it is not the current one.
 *
 * A copy of the private helper in `fin.ts` on purpose: this module does not edit
 * that file, and three lines of date formatting are cheaper to duplicate than a
 * new shared surface between the two.
 */
function shortDate(dateIso: string): string {
  const [year, month, day] = dateIso.split("-");
  return year === today().slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
}

/** One decimal place, the rounding the rest of the CLI uses for percentages. */
const pctOf = (part: number, whole: number): number =>
  whole ? Math.round((part * 1000) / whole) / 10 : 0;

/** `24.7` -> `24,7`, because the text is read in Portuguese. */
const pctText = (pct: number): string => pct.toLocaleString("pt-BR");

/* -------------------------------------------------------------------------- */
/* Cycles                                                                     */
/* -------------------------------------------------------------------------- */

/** What the cycle maths needs from a card. Nothing else. */
export interface CardCycleConfig {
  closing_day?: number | null;
  due_day?: number | null;
}

export interface StatementCycle {
  /** `YYYY-MM` of the closing date. A statement is named after the month it closes in. */
  month: string;
  /** First date billed on this statement (inclusive). */
  start: string;
  /** Last date billed on this statement (inclusive). */
  end: string;
  /**
   * The day the statement closes. Already the first day of the *next* cycle, so
   * it is deliberately one day after `end`.
   */
  closing_date: string;
  /** When it has to be paid; null when the card has no `due_day` configured. */
  due_date: string | null;
  closing_day: number | null;
  due_day: number | null;
  /** False when the card has no closing day and this is a plain calendar month. */
  has_closing_day: boolean;
  /** Portuguese, for the text output. */
  label: string;
}

/**
 * Validates a configured day of month.
 *
 * The schema already CHECKs `BETWEEN 1 AND 31`, but a database edited by hand is
 * a real possibility here, and silently computing a cycle from `closing_day = 0`
 * would produce a plausible-looking wrong bill.
 */
function configuredDay(value: number | null | undefined, what: string): number | null {
  if (value === null || value === undefined) return null;
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new FinError(
      `O dia de ${what} cadastrado nesse cartão é inválido (${String(value)}). Use um dia entre 1 e 31.`,
    );
  }
  return day;
}

/**
 * The due date of the statement that closes in `year`/`month`.
 *
 * Convention 2 of the header comment: `due_day > closing_day` pays in the
 * closing month, anything else pays in the following one. The day is clamped
 * afterwards, so a card due on the 31st pays on 28/02.
 */
function dueDateFor(
  year: number,
  month: number,
  closingDay: number,
  dueDay: number | null,
): string | null {
  if (dueDay === null) return null;
  if (dueDay > closingDay) return clampedDate(year, month, dueDay);
  const next = shiftMonth(year, month, 1);
  return clampedDate(next.year, next.month, dueDay);
}

/** The statement named `month` (`YYYY-MM`), i.e. the one that closes in it. */
export function statementForMonth(card: CardCycleConfig, month: string): StatementCycle {
  const { year, month: m } = splitMonth(month);
  const closingDay = configuredDay(card.closing_day, "fechamento");
  const dueDay = configuredDay(card.due_day, "vencimento");
  const key = monthKey(year, m);

  // No closing day: calendar month, and say so. Failing here would leave the
  // user with no answer at all for a card they just created, which is worse than
  // an approximate one that announces itself.
  if (closingDay === null) {
    const last = lastDayOfMonth(year, m);
    return {
      month: key,
      start: iso(year, m, 1),
      end: iso(year, m, last),
      closing_date: iso(year, m, last),
      due_date: dueDateFor(year, m, last, dueDay),
      closing_day: null,
      due_day: dueDay,
      has_closing_day: false,
      label: `fatura de ${monthLabel(key)}`,
    };
  }

  const closing = clampedDate(year, m, closingDay);
  const previous = shiftMonth(year, m, -1);
  // The previous closing date is computed from its own month, never as
  // `addMonths(closing, -1)`: with closing_day 31, February closes on the 28th
  // and stepping a month back from there would land on 28/01 instead of 31/01,
  // silently losing three days of purchases.
  const start = clampedDate(previous.year, previous.month, closingDay);

  return {
    month: key,
    start,
    end: addDays(closing, -1),
    closing_date: closing,
    due_date: dueDateFor(year, m, closingDay, dueDay),
    closing_day: closingDay,
    due_day: dueDay,
    has_closing_day: true,
    label: `fatura de ${monthLabel(key)}`,
  };
}

/**
 * Which statement a purchase made on `date` lands on.
 *
 * The whole feature is this function. On the closing day itself the purchase
 * goes to the next statement (convention 1).
 */
export function statementForDate(card: CardCycleConfig, date: string): StatementCycle {
  const day = parseDate(date);
  const closingDay = configuredDay(card.closing_day, "fechamento");
  if (closingDay === null) return statementForMonth(card, monthOf(day));

  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const closing = clampedDate(year, month, closingDay);
  const target = day >= closing ? shiftMonth(year, month, 1) : { year, month };
  return statementForMonth(card, monthKey(target.year, target.month));
}

/** The statement `delta` cycles away from `cycle` (-1 = the previous one). */
export function shiftStatement(
  card: CardCycleConfig,
  cycle: StatementCycle,
  delta: number,
): StatementCycle {
  const { year, month } = splitMonth(cycle.month);
  const target = shiftMonth(year, month, delta);
  return statementForMonth(card, monthKey(target.year, target.month));
}

export type StatementSelector = "open" | "last" | "next" | string;

/**
 * Turns what the user asked for into a cycle.
 *
 * - `open` (the default): the statement today's purchases fall on.
 * - `last`: the one that closed most recently — the bill you are paying now.
 * - `next`: the one that comes due first from `reference` on, which is `last`
 *   while its due date has not passed and `open` afterwards.
 * - `YYYY-MM`: named explicitly, by closing month.
 */
export function resolveStatement(
  card: CardCycleConfig,
  selector?: string | null,
  reference?: string,
): StatementCycle {
  const ref = parseDate(reference);
  const open = statementForDate(card, ref);
  const choice = normalize(selector ?? "open") || "open";

  if (isValidMonth(choice)) return statementForMonth(card, choice);

  switch (choice) {
    case "open":
    case "current":
    case "aberta":
    case "atual":
      return open;
    case "last":
    case "closed":
    case "previous":
    case "fechada":
    case "anterior":
      return shiftStatement(card, open, -1);
    case "next":
    case "due":
    case "proxima":
    case "vencendo": {
      // "The one due next" is a question about due dates, not about cycles: the
      // statement that closed last is usually still unpaid and comes due before
      // the open one. With no due_day there is nothing to order by, so the open
      // statement is the honest answer.
      const candidates = [shiftStatement(card, open, -1), open, shiftStatement(card, open, 1)];
      const dated = candidates
        .filter((c) => c.due_date !== null && c.due_date >= ref)
        .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
      return dated[0] ?? open;
    }
  }

  throw new FinError(
    `Não entendi qual fatura você quer (${JSON.stringify(selector)}). ` +
      `Use aberta, fechada, proxima ou YYYY-MM.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Reading the ledger                                                         */
/* -------------------------------------------------------------------------- */

export interface CardRow {
  id: number;
  name: string;
  type: string;
  institution: string | null;
  closing_day: number | null;
  due_day: number | null;
  limit_cents: number | null;
}

const CARD_COLUMNS =
  "id, name, type, institution, closing_day, due_day, limit_cents";

/** Every active card of this user, in a stable order. */
export function listCards(db: Db, userId: number): CardRow[] {
  return db
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM accounts ` +
        "WHERE user_id = ? AND active = 1 AND type = 'card' ORDER BY name",
    )
    .all(userId) as CardRow[];
}

/**
 * Finds the card the user meant.
 *
 * With no name: the only card, when there is exactly one. Not the default
 * account — that one is "Carteira", a cash account, and a statement for cash is
 * meaningless. With several cards it asks instead of guessing, because guessing
 * would answer confidently about the wrong bill.
 *
 * Name matching mirrors `resolveAccount`: exact first, then containment, and an
 * ambiguous match is an error rather than a coin toss.
 */
export function loadCard(db: Db, userId: number, name?: string | null): CardRow {
  const cards = listCards(db, userId);

  if (!name || !String(name).trim()) {
    if (cards.length === 1) return cards[0];
    if (cards.length === 0) {
      throw new FinError(
        "Você não tem nenhum cartão de crédito cadastrado. " +
          "Crie com `account add --type card --closing 25 --due 5`.",
      );
    }
    throw new FinError(
      `Você tem mais de um cartão (${cards.map((c) => c.name).join(", ")}). ` +
        "Diga de qual você quer a fatura.",
    );
  }

  const target = normalize(String(name));
  const exact = cards.find((c) => normalize(c.name) === target);
  if (exact) return exact;

  const partial = cards.filter((c) => {
    const n = normalize(c.name);
    return n.includes(target) || target.includes(n);
  });
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new FinError(
      `Mais de um cartão casa com ${JSON.stringify(name)}: ` +
        `${partial.map((c) => c.name).join(", ")}. Seja específico.`,
    );
  }

  // The account may exist and just not be a card — worth a different message,
  // since "não existe" would send the user looking for a typo. Scoped to this
  // user, so it never confirms the existence of the other person's account.
  const other = db
    .prepare("SELECT name, type FROM accounts WHERE user_id = ? AND active = 1")
    .all(userId) as { name: string; type: string }[];
  const match = other.find((a) => {
    const n = normalize(a.name);
    return n === target || n.includes(target) || target.includes(n);
  });
  if (match) {
    throw new FinError(
      `A conta ${JSON.stringify(match.name)} não é um cartão de crédito, então não tem fatura. ` +
        "Veja o saldo dela com `balance`.",
    );
  }

  throw new FinError(
    `Não achei o cartão ${JSON.stringify(name)}. ` +
      `${cards.length ? `Você tem: ${cards.map((c) => c.name).join(", ")}.` : "Rode `account list`."}`,
  );
}

/** Total spent on a card inside a cycle. Expenses only. */
function cycleTotal(
  db: Db,
  userId: number,
  cardId: number,
  cycle: StatementCycle,
): { total_cents: number; count: number } {
  // Paying the bill is recorded as a transfer to the card, so counting only
  // 'expense' is what keeps the payment from cancelling out the purchases it
  // pays for. Transfers and income never belong on a statement.
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND type = 'expense' AND date BETWEEN ? AND ?",
    )
    .get(userId, cardId, cycle.start, cycle.end) as { total: number; n: number };
  return { total_cents: Number(row.total), count: Number(row.n) };
}

export interface StatementCategory {
  category: string;
  emoji: string | null;
  total_cents: number;
  total_fmt: string;
  count: number;
  pct: number;
}

export interface StatementInstallment {
  id: number;
  description: string;
  date: string;
  amount_cents: number;
  amount_fmt: string;
  installment: string;
  installment_num: number;
  installment_total: number;
}

export interface StatementView extends Output {
  account: {
    id: number;
    name: string;
    institution: string | null;
    closing_day: number | null;
    due_day: number | null;
    limit_cents: number | null;
  };
  statement: StatementCycle;
  total_cents: number;
  total_fmt: string;
  count: number;
  by_category: StatementCategory[];
  installments: StatementInstallment[];
  limit: {
    limit_cents: number;
    limit_fmt: string;
    used_pct: number;
    remaining_cents: number;
    remaining_fmt: string;
  } | null;
  previous: {
    month: string;
    total_cents: number;
    total_fmt: string;
    difference_cents: number;
    difference_fmt: string;
    change_pct: number | null;
  };
  text: string;
}

/**
 * One card, one statement: the cycle, the total, where it went, and the text.
 *
 * `reference` exists so the caller — and the tests — can ask what the statement
 * looked like on some other day. It defaults to today in São Paulo.
 */
export function statementView(
  db: Db,
  userId: number,
  options: { account?: string | null; statement?: string | null; reference?: string } = {},
): StatementView {
  const card = loadCard(db, userId, options.account);
  const cycle = resolveStatement(card, options.statement, options.reference);

  const { total_cents: total, count } = cycleTotal(db, userId, card.id, cycle);

  // Rolled up to the root category, the way `aggregate` in fin.ts does it: a
  // statement split into 30 subcategories is unreadable on a phone.
  const categoryRows = db
    .prepare(
      "SELECT COALESCE(cp.name, c.name, 'Sem categoria') AS category," +
        "       COALESCE(cp.emoji, c.emoji)              AS emoji," +
        "       SUM(t.amount_cents)                      AS total," +
        "       COUNT(*)                                 AS n " +
        "FROM transactions t " +
        "LEFT JOIN categories c  ON c.id  = t.category_id " +
        "LEFT JOIN categories cp ON cp.id = c.parent_id " +
        "WHERE t.user_id = ? AND t.account_id = ? AND t.type = 'expense' " +
        "  AND t.date BETWEEN ? AND ? " +
        "GROUP BY category ORDER BY total DESC",
    )
    .all(userId, card.id, cycle.start, cycle.end) as {
    category: string;
    emoji: string | null;
    total: number;
    n: number;
  }[];

  const installmentRows = db
    .prepare(
      "SELECT id, description, date, amount_cents, installment_num, installment_total " +
        "FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND type = 'expense' " +
        "  AND installment_total IS NOT NULL AND date BETWEEN ? AND ? " +
        "ORDER BY date, id",
    )
    .all(userId, card.id, cycle.start, cycle.end) as {
    id: number;
    description: string;
    date: string;
    amount_cents: number;
    installment_num: number | null;
    installment_total: number;
  }[];

  const previousCycle = shiftStatement(card, cycle, -1);
  const previousTotal = cycleTotal(db, userId, card.id, previousCycle).total_cents;
  const difference = total - previousTotal;

  const view: StatementView = {
    account: {
      id: card.id,
      name: card.name,
      institution: card.institution,
      closing_day: card.closing_day,
      due_day: card.due_day,
      limit_cents: card.limit_cents,
    },
    statement: cycle,
    total_cents: total,
    total_fmt: formatMoney(total),
    count,
    by_category: categoryRows.map((r) => ({
      category: r.category,
      emoji: r.emoji,
      total_cents: r.total,
      total_fmt: formatMoney(r.total),
      count: r.n,
      pct: pctOf(r.total, total),
    })),
    installments: installmentRows.map((r) => ({
      id: r.id,
      description: r.description,
      date: r.date,
      amount_cents: r.amount_cents,
      amount_fmt: formatMoney(r.amount_cents),
      installment: `${r.installment_num ?? 1}/${r.installment_total}`,
      installment_num: r.installment_num ?? 1,
      installment_total: r.installment_total,
    })),
    limit: card.limit_cents
      ? {
          limit_cents: card.limit_cents,
          limit_fmt: formatMoney(card.limit_cents),
          used_pct: pctOf(total, card.limit_cents),
          remaining_cents: card.limit_cents - total,
          remaining_fmt: formatMoney(card.limit_cents - total),
        }
      : null,
    previous: {
      month: previousCycle.month,
      total_cents: previousTotal,
      total_fmt: formatMoney(previousTotal),
      difference_cents: difference,
      difference_fmt: formatMoney(difference),
      change_pct: previousTotal ? pctOf(difference, previousTotal) : null,
    },
    text: "",
  };

  view.text = statementText(view);
  return view;
}

/**
 * The statement in Portuguese, ready to forward to Telegram.
 *
 * No markdown tables — Telegram does not render them, and a table of a card's
 * categories is exactly what one is tempted to write here. One fact per line,
 * emoji as the anchor, same shape as `cmdReport`.
 */
function statementText(view: StatementView): string {
  const c = view.statement;
  const lines: string[] = [];

  lines.push(`💳 *${view.account.name} — ${c.label}*`);
  lines.push(`_Compras de ${shortDate(c.start)} a ${shortDate(c.end)}_`);

  const closing = c.has_closing_day
    ? `🗓 Fecha em ${shortDate(c.closing_date)}`
    : `🗓 Mês de ${monthLabel(c.month)}`;
  lines.push(
    c.due_date
      ? `${closing} · vence em ${shortDate(c.due_date)}`
      : `${closing} · vencimento não cadastrado`,
  );

  if (!c.has_closing_day) {
    lines.push(
      "⚠️ Esse cartão não tem dia de fechamento cadastrado, então usei o mês civil — " +
        "a fatura real pode ser diferente.",
    );
  }

  const header = lines.length;

  lines.push("");
  lines.push(`💸 Total: *${view.total_fmt}*`);
  lines.push(`🧾 ${view.count} ${view.count === 1 ? "compra" : "compras"}`);

  if (view.previous.total_cents) {
    const delta = view.previous.difference_cents;
    const pct = Math.abs(pctOf(delta, view.previous.total_cents));
    if (pct < 1) {
      lines.push(`➡️ Praticamente igual à fatura de ${monthLabel(view.previous.month)}.`);
    } else if (delta > 0) {
      lines.push(
        `📈 ${Math.round(pct)}% acima da fatura de ${monthLabel(view.previous.month)} ` +
          `(${formatMoney(delta)} a mais)`,
      );
    } else {
      lines.push(
        `📉 ${Math.round(pct)}% abaixo da fatura de ${monthLabel(view.previous.month)} ` +
          `(${formatMoney(-delta)} a menos)`,
      );
    }
  }

  if (view.limit) {
    lines.push(
      `🏦 Limite: ${view.limit.limit_fmt} · ${pctText(view.limit.used_pct)}% comprometido ` +
        `(livre: ${view.limit.remaining_fmt})`,
    );
  }

  if (view.by_category.length) {
    lines.push("");
    lines.push("*Onde o dinheiro foi:*");
    for (const cat of view.by_category.slice(0, 8)) {
      lines.push(
        `${cat.emoji ?? "•"} ${cat.category} — ${cat.total_fmt} (${Math.round(cat.pct)}%)`,
      );
    }
    const rest = view.by_category.length - 8;
    if (rest > 0) lines.push(`_... e ${rest} categoria(s) menor(es)_`);
  }

  if (view.installments.length) {
    const parceled = view.installments.reduce((s, i) => s + i.amount_cents, 0);
    lines.push("");
    lines.push(`*Parcelas nesta fatura* (${formatMoney(parceled)}):`);
    for (const i of view.installments.slice(0, 10)) {
      lines.push(`• ${i.description} ${i.installment} — ${i.amount_fmt}`);
    }
    const rest = view.installments.length - 10;
    if (rest > 0) lines.push(`_... e ${rest} parcela(s)_`);
  }

  if (view.count === 0) {
    // Keeping the header — which cycle, when it closes, when it is due — and
    // replacing only the body: "nothing here" plus the dates is a useful answer,
    // an empty message is not.
    return [
      ...lines.slice(0, header),
      "",
      "🙂 Nenhuma compra nessa fatura por enquanto.",
      view.previous.total_cents
        ? `A anterior (${monthLabel(view.previous.month)}) fechou em ${view.previous.total_fmt}.`
        : "Também não achei compras na fatura anterior.",
    ].join("\n");
  }

  return lines.join("\n");
}

export interface CardBill {
  account_id: number;
  account: string;
  institution: string | null;
  statement_month: string;
  start: string;
  end: string;
  closing_date: string;
  due_date: string | null;
  has_closing_day: boolean;
  total_cents: number;
  total_fmt: string;
  count: number;
  limit_used_pct: number | null;
}

export interface CardBillsOverview extends Output {
  cards: CardBill[];
  total_cents: number;
  total_fmt: string;
  text: string;
}

/**
 * Every card with its open statement — the answer to "quanto devo nos cartões?".
 *
 * "Open" is the statement today's purchases fall on, so the total is what is
 * accumulating right now, not what is already due. Cards with no purchases in
 * the cycle are listed anyway, at zero: a card missing from the list reads as
 * "you have no such card".
 */
export function openCardBills(db: Db, userId: number, reference?: string): CardBillsOverview {
  const ref = parseDate(reference);
  const cards = listCards(db, userId);

  const bills: CardBill[] = cards.map((card) => {
    const cycle = statementForDate(card, ref);
    const { total_cents: total, count } = cycleTotal(db, userId, card.id, cycle);
    return {
      account_id: card.id,
      account: card.name,
      institution: card.institution,
      statement_month: cycle.month,
      start: cycle.start,
      end: cycle.end,
      closing_date: cycle.closing_date,
      due_date: cycle.due_date,
      has_closing_day: cycle.has_closing_day,
      total_cents: total,
      total_fmt: formatMoney(total),
      count,
      limit_used_pct: card.limit_cents ? pctOf(total, card.limit_cents) : null,
    };
  });

  // Soonest due first, since that is the order in which the money leaves. Cards
  // with no due day configured go last, then by name.
  bills.sort((a, b) => {
    if (a.due_date && b.due_date && a.due_date !== b.due_date) {
      return a.due_date < b.due_date ? -1 : 1;
    }
    if (a.due_date && !b.due_date) return -1;
    if (!a.due_date && b.due_date) return 1;
    return a.account.localeCompare(b.account, "pt-BR");
  });

  const total = bills.reduce((s, b) => s + b.total_cents, 0);

  const lines: string[] = ["💳 *Faturas em aberto*"];
  if (!bills.length) {
    lines.push("Você não tem nenhum cartão de crédito cadastrado.");
  } else {
    for (const b of bills) {
      const due = b.due_date
        ? `vence ${shortDate(b.due_date)}`
        : "sem vencimento cadastrado";
      const closing = b.has_closing_day
        ? `fecha ${shortDate(b.closing_date)}`
        : "sem fechamento cadastrado";
      lines.push(`• ${b.account} — *${b.total_fmt}* · ${closing} · ${due}`);
    }
    if (bills.length > 1) {
      lines.push("");
      lines.push(`Total nos cartões: *${formatMoney(total)}*`);
    }
  }

  return {
    cards: bills,
    total_cents: total,
    total_fmt: formatMoney(total),
    text: lines.join("\n"),
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" ? v : undefined;
};

/**
 * The `users.id` the caller is acting for.
 *
 * An internal id, not a Telegram one: `fin.ts` owns identity and authentication,
 * and by the time this module runs the caller is already known. Existence is
 * still checked, so a typo answers "unknown user" instead of quietly reporting
 * an empty statement for a user that does not exist.
 */
function requireUserId(db: Db, a: Args): number {
  const raw = str(a, "user-id");
  if (raw === undefined || raw.trim() === "") {
    throw new FinError("Informe --user-id (o id interno do usuário).");
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FinError("--user-id precisa ser um número inteiro positivo (users.id).");
  }
  const row = db.prepare("SELECT id FROM users WHERE id = ?").get(id) as
    | { id: number }
    | undefined;
  if (!row) throw new FinError("Usuário não encontrado.");
  return row.id;
}

/** `bill` as a subcommand, for whoever wires this into the main CLI. */
export function cmdBill(db: Db, userId: number, a: Args): Output {
  if (a["all"] === true) return openCardBills(db, userId, str(a, "reference"));
  return statementView(db, userId, {
    account: str(a, "account"),
    statement: str(a, "statement"),
    reference: str(a, "reference"),
  });
}

const USAGE = `Credit-card statement (fatura) for one card, by real cycle instead of calendar month.

  node bill.ts --db <path> --user-id <n> [--account <name>]
               [--statement <open|last|next|YYYY-MM>] [--json] [--all]

  --user-id     internal users.id (an integer), not a Telegram id
  --account     which card; optional when the user has exactly one
  --statement   open (default) | last | next | YYYY-MM (the closing month)
  --all         every card with its open statement total and due date
  --reference   pretend today is this date (YYYY-MM-DD), for checking a past cycle
  --json        print the full {"ok": true, ...} envelope; without it, only the
                Portuguese text is printed. Failures are always JSON, exit 1.
`;

export function main(argv: string[]): number {
  try {
    let values: Args;
    try {
      values = parseArgs({
        args: argv,
        options: {
          db: { type: "string" },
          "user-id": { type: "string" },
          account: { type: "string" },
          statement: { type: "string" },
          reference: { type: "string" },
          all: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean" },
        },
        allowPositionals: false,
        strict: true,
      }).values as Args;
    } catch (e) {
      throw new FinError(
        `${(e as Error).message}. Opções aceitas: --db, --user-id, --account, ` +
          `--statement, --reference, --all, --json.`,
      );
    }

    if (values["help"] === true) {
      process.stdout.write(USAGE);
      return 0;
    }

    const db = connect(str(values, "db") ?? process.env.TALLY_DB);
    let output: Output;
    try {
      if (currentVersion(db) < CURRENT_SCHEMA_VERSION) migrate(db);
      const userId = requireUserId(db, values);
      output = cmdBill(db, userId, values);
    } finally {
      db.close();
    }

    if (values["json"] === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
    } else {
      process.stdout.write(`${String(output.text ?? "")}\n`);
    }
    return 0;
  } catch (e) {
    const message =
      e instanceof FinError
        ? e.message
        : `Erro inesperado: ${(e as Error).message ?? String(e)}`;
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
