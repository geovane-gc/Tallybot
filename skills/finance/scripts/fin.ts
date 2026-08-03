#!/usr/bin/env node
/**
 * Finance CLI — the tool the Telegram agent drives.
 *
 * Why one CLI with subcommands instead of several scripts: the model driving it
 * is a free tier. A single entry point, named options and always-JSON output cut
 * down the ways it can get a call wrong. Every bit of money, calendar and budget
 * arithmetic lives here — the model decides *what* to record, never *how* to
 * compute it.
 *
 * Output contract, honoured by every subcommand:
 *
 *     success -> {"ok": true,  ...data}       exit 0
 *     failure -> {"ok": false, "error": "…"}  exit 1
 *
 * The `error` text is Portuguese and written to be forwarded to the user as-is;
 * everything else here is English. See the language note in `db.ts`.
 *
 * Usage:
 *     node fin.ts [--db PATH] <subcommand> [options]
 *
 * The database path comes from --db, the TALLY_DB env var, or the default
 * /opt/data/finance/tally.db (inside the container).
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  ACCOUNT_TYPES,
  CURRENT_SCHEMA_VERSION,
  FinError,
  TRANSACTION_TYPES,
  addDays,
  addMonths,
  applyTags,
  categoryAndChildrenIds,
  connect,
  currentVersion,
  formatMoney,
  fullCategoryName,
  getSetting,
  init,
  isValidMonth,
  lastDayOfMonth,
  migrate,
  monthOf,
  now,
  parseAmount,
  parseDate,
  periodRange,
  resolveAccount,
  resolveCategory,
  seed,
  serializeTransaction,
  setSetting,
  today,
  transaction,
  type AccountType,
  type BudgetStatus,
  type Db,
  type Period,
  type TransactionOut,
  type TransactionRow,
  type TransactionType,
} from "./db.ts";

type Args = Record<string, string | boolean | undefined>;
type Output = Record<string, unknown>;

const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" ? v : undefined;
};
const int = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new FinError(`--${k} precisa ser um número inteiro.`);
  return n;
};
const flag = (a: Args, k: string): boolean => a[k] === true;

function asTransactionType(v: string | undefined, fallback?: TransactionType) {
  if (v === undefined) return fallback;
  if (!TRANSACTION_TYPES.includes(v as TransactionType)) {
    throw new FinError(`Tipo inválido: ${v}. Use expense, income ou transfer.`);
  }
  return v as TransactionType;
}

function sum(db: Db, sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>;
  const first = row ? Object.values(row)[0] : 0;
  return Number(first ?? 0);
}

function fetchTransaction(db: Db, id: number): TransactionOut {
  const row = db.prepare("SELECT * FROM v_transactions WHERE id = ?").get(id) as
    | TransactionRow
    | undefined;
  if (!row) throw new FinError(`Não achei o lançamento #${id}.`);
  return serializeTransaction(db, row);
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .replaceAll(";", ",")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** `2026-08-03` -> `03/08`. Year only when it is not the current one. */
function shortDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year === today().slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
}

/** `2026-08-03` -> `03/08/2026`. Exports need the year to sort and filter. */
function fullDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export function cmdAdd(db: Db, a: Args): Output {
  const type = asTransactionType(str(a, "type"), "expense")!;
  const total = parseAmount(str(a, "amount"));
  const date = parseDate(str(a, "date"));
  const description = (str(a, "description") ?? "").trim();
  if (!description) {
    throw new FinError(
      "Descrição é obrigatória — é o que te faz reconhecer o gasto depois.",
    );
  }

  const accountId = resolveAccount(db, str(a, "account"));
  let destAccountId: number | null = null;
  let categoryId: number | null = null;

  if (type === "transfer") {
    const dest = str(a, "dest-account");
    if (!dest) throw new FinError("Transferência precisa de --dest-account.");
    destAccountId = resolveAccount(db, dest, false);
    if (destAccountId === accountId) {
      throw new FinError("A conta de origem e destino são a mesma.");
    }
  } else {
    // `create = true`: better to register a new category than to reject the
    // transaction and have the user lose the record.
    categoryId = resolveCategory(db, str(a, "category"), true);
  }

  const installments = int(a, "installments") ?? 1;
  if (installments < 1 || installments > 120) {
    throw new FinError("Número de parcelas fora do razoável (1 a 120).");
  }

  const ts = now();
  const tags = splitList(str(a, "tags"));
  const group =
    installments > 1 ? randomUUID().replaceAll("-", "").slice(0, 12) : null;

  // Splitting instalments without losing a cent: the remainder goes on the first.
  const base = Math.floor(total / installments);
  const remainder = total - base * installments;

  const created: number[] = [];
  transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO transactions (" +
        "  type, amount_cents, description, date, category_id, account_id," +
        "  dest_account_id, note, source, installment_num, installment_total," +
        "  installment_group, created_at, updated_at" +
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < installments; i++) {
      const info = insert.run(
        type,
        base + (i === 0 ? remainder : 0),
        description,
        addMonths(date, i),
        categoryId,
        accountId,
        destAccountId,
        str(a, "note") ?? null,
        str(a, "source") ?? "telegram",
        installments > 1 ? i + 1 : null,
        installments > 1 ? installments : null,
        group,
        ts,
        ts,
      );
      created.push(Number(info.lastInsertRowid));
    }
  });

  if (tags.length) {
    for (const id of created) applyTags(db, id, tags);
  }

  // Only one of the two fields ships in the response: context on a free-tier
  // model is expensive, and returning the same record twice helps nobody.
  const records = created.map((id) => fetchTransaction(db, id));
  const out: Output = {
    id: created[0],
    total_fmt: formatMoney(total),
    installment_plan: installments > 1,
  };
  if (installments > 1) {
    out.installments = records;
    out.installment_amount_fmt = records[records.length - 1].amount_fmt;
  } else {
    out.transaction = records[0];
  }

  // The alert rides along with the confirmation, so the agent can warn about the
  // budget in the same reply instead of making a second call.
  if (type === "expense" && categoryId) {
    out.budget = budgetForCategory(db, categoryId, monthOf(date));
  }

  return out;
}

export function cmdEdit(db: Db, a: Args, positionals: string[]): Output {
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) throw new FinError("Informe o id do lançamento.");
  if (!db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(id)) {
    throw new FinError(`Não achei o lançamento #${id}.`);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (str(a, "amount") !== undefined) {
    fields.push("amount_cents = ?");
    values.push(parseAmount(str(a, "amount")));
  }
  if (str(a, "description") !== undefined) {
    fields.push("description = ?");
    values.push(str(a, "description")!.trim());
  }
  if (str(a, "date") !== undefined) {
    fields.push("date = ?");
    values.push(parseDate(str(a, "date")));
  }
  if (str(a, "category") !== undefined) {
    fields.push("category_id = ?");
    values.push(resolveCategory(db, str(a, "category"), true));
  }
  if (str(a, "account") !== undefined) {
    fields.push("account_id = ?");
    values.push(resolveAccount(db, str(a, "account")));
  }
  if (str(a, "type") !== undefined) {
    fields.push("type = ?");
    values.push(asTransactionType(str(a, "type"))!);
  }
  if (str(a, "note") !== undefined) {
    fields.push("note = ?");
    values.push(str(a, "note"));
  }

  const hasTags = str(a, "tags") !== undefined;
  if (!fields.length && !hasTags) {
    throw new FinError("Nada para alterar — informe ao menos um campo.");
  }

  if (fields.length) {
    fields.push("updated_at = ?");
    values.push(now(), id);
    db.prepare(`UPDATE transactions SET ${fields.join(", ")} WHERE id = ?`).run(
      ...(values as never[]),
    );
  }

  if (hasTags) applyTags(db, id, splitList(str(a, "tags")));

  const record = fetchTransaction(db, id);
  const out: Output = { transaction: record };
  if (record.type === "expense" && record.category_id) {
    out.budget = budgetForCategory(db, record.category_id, monthOf(record.date));
  }
  return out;
}

export function cmdRm(db: Db, a: Args, positionals: string[]): Output {
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) throw new FinError("Informe o id do lançamento.");
  const target = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
    | { installment_group: string | null }
    | undefined;
  if (!target) throw new FinError(`Não achei o lançamento #${id}.`);

  let ids = [id];
  if (flag(a, "group") && target.installment_group) {
    ids = (
      db
        .prepare("SELECT id FROM transactions WHERE installment_group = ?")
        .all(target.installment_group) as { id: number }[]
    ).map((r) => r.id);
  }

  const removed = ids.map((i) => fetchTransaction(db, i));
  transaction(db, () => {
    const del = db.prepare("DELETE FROM transactions WHERE id = ?");
    for (const i of ids) del.run(i);
  });

  return { removed, count: ids.length };
}

interface Filters {
  where: string;
  params: unknown[];
  context: Output;
}

function buildFilters(db: Db, a: Args): Filters {
  const clauses = ["1=1"];
  const params: unknown[] = [];
  const context: Output = {};

  const period = str(a, "period");
  if (period) {
    const p = periodRange(period);
    clauses.push("date BETWEEN ? AND ?");
    params.push(p.start, p.end);
    context.period = p;
  }

  const category = str(a, "category");
  if (category) {
    const categoryId = resolveCategory(db, category)!;
    const ids = categoryAndChildrenIds(db, categoryId);
    clauses.push(`category_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    context.category = fullCategoryName(db, categoryId);
  }

  const account = str(a, "account");
  if (account) {
    const accountId = resolveAccount(db, account, false);
    clauses.push("(account_id = ? OR dest_account_id = ?)");
    params.push(accountId, accountId);
    context.account = account;
  }

  const type = str(a, "type");
  if (type) {
    clauses.push("type = ?");
    params.push(asTransactionType(type)!);
    context.type = type;
  }

  const tag = str(a, "tag");
  if (tag) {
    clauses.push(
      "id IN (SELECT tt.transaction_id FROM transaction_tags tt " +
        "JOIN tags t ON t.id = tt.tag_id WHERE t.name = ?)",
    );
    params.push(tag.replace(/^#/, ""));
    context.tag = tag;
  }

  const text = str(a, "text");
  if (text) {
    clauses.push("description LIKE ? COLLATE NOCASE");
    params.push(`%${text}%`);
    context.text = text;
  }

  return { where: clauses.join(" AND "), params, context };
}

function totalsByType(db: Db, where: string, params: unknown[]): Output {
  const rows = db
    .prepare(
      `SELECT type, SUM(amount_cents) AS s, COUNT(*) AS n FROM v_transactions WHERE ${where} GROUP BY type`,
    )
    .all(...(params as never[])) as { type: TransactionType; s: number; n: number }[];

  const byType = new Map(rows.map((r) => [r.type, r]));
  const out: Output = {};
  for (const type of TRANSACTION_TYPES) {
    const info = byType.get(type);
    const value = Number(info?.s ?? 0);
    out[type] = {
      cents: value,
      fmt: formatMoney(value),
      count: Number(info?.n ?? 0),
    };
  }
  return out;
}

export function cmdLs(db: Db, a: Args): Output {
  const { where, params, context } = buildFilters(db, a);
  const order = str(a, "order") === "asc" ? "date ASC, id ASC" : "date DESC, id DESC";
  const limit = Math.max(1, Math.min(int(a, "limit") ?? 30, 500));

  const rows = db
    .prepare(`SELECT * FROM v_transactions WHERE ${where} ORDER BY ${order} LIMIT ?`)
    .all(...([...params, limit] as never[])) as TransactionRow[];

  const items = rows.map((r) => serializeTransaction(db, r));
  const totals = totalsByType(db, where, params);
  const totalCount = TRANSACTION_TYPES.reduce(
    (acc, t) => acc + Number((totals[t] as { count: number }).count),
    0,
  );

  return {
    filter: context,
    shown_count: items.length,
    total_count: totalCount,
    totals,
    transactions: items,
  };
}

export function cmdSearch(db: Db, a: Args, positionals: string[]): Output {
  const term = (positionals[0] ?? "").trim();
  if (!term) throw new FinError("Informe o que buscar.");
  const limit = Math.max(1, Math.min(int(a, "limit") ?? 20, 200));
  const like = `%${term}%`;

  const rows = db
    .prepare(
      "SELECT * FROM v_transactions WHERE description LIKE ? COLLATE NOCASE " +
        "OR IFNULL(note,'') LIKE ? COLLATE NOCASE " +
        "ORDER BY date DESC, id DESC LIMIT ?",
    )
    .all(like, like, limit) as TransactionRow[];

  const items = rows.map((r) => serializeTransaction(db, r));
  const spent = items
    .filter((i) => i.type === "expense")
    .reduce((acc, i) => acc + i.amount_cents, 0);

  return {
    term,
    count: items.length,
    total_expenses_fmt: formatMoney(spent),
    transactions: items,
  };
}

/**
 * Balance per account plus net worth.
 *
 * A credit card shows a negative balance while its bill is open — reading
 * "-R$ 800,00" as "you owe R$ 800,00" is the intended behaviour.
 */
export function cmdBalance(db: Db): Output {
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE active = 1 ORDER BY type, name")
    .all() as {
    id: number;
    name: string;
    type: AccountType;
    institution: string | null;
    due_day: number | null;
    limit_cents: number | null;
    opening_balance_cents: number;
  }[];

  const currentMonth = monthOf(today());
  const result: Output[] = [];
  let total = 0;
  let totalExcludingCards = 0;

  for (const acc of accounts) {
    const income = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions WHERE account_id = ? AND type = 'income'",
      [acc.id],
    );
    const expenses = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions WHERE account_id = ? AND type = 'expense'",
      [acc.id],
    );
    const out = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions WHERE account_id = ? AND type = 'transfer'",
      [acc.id],
    );
    const incoming = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions WHERE dest_account_id = ? AND type = 'transfer'",
      [acc.id],
    );

    const balance = acc.opening_balance_cents + income + incoming - expenses - out;

    const item: Output = {
      id: acc.id,
      name: acc.name,
      type: acc.type,
      institution: acc.institution,
      balance_cents: balance,
      balance_fmt: formatMoney(balance),
    };

    if (acc.type === "card") {
      const bill = sum(
        db,
        "SELECT SUM(amount_cents) FROM transactions " +
          "WHERE account_id = ? AND type = 'expense' AND substr(date,1,7) = ?",
        [acc.id, currentMonth],
      );
      item.month_bill_cents = bill;
      item.month_bill_fmt = formatMoney(bill);
      item.due_day = acc.due_day;
      if (acc.limit_cents) {
        item.limit_fmt = formatMoney(acc.limit_cents);
        item.limit_used_pct = Math.round((bill * 1000) / acc.limit_cents) / 10;
      }
    } else {
      totalExcludingCards += balance;
    }

    total += balance;
    result.push(item);
  }

  return {
    accounts: result,
    total_cents: total,
    total_fmt: formatMoney(total),
    total_excluding_cards_fmt: formatMoney(totalExcludingCards),
  };
}

interface Aggregate extends Output {
  expenses_cents: number;
  income_cents: number;
  by_category: {
    category: string;
    emoji: string | null;
    total_cents: number;
    total_fmt: string;
    count: number;
    pct: number;
  }[];
  top_expenses: TransactionOut[];
  count: number;
}

/**
 * Raw numbers for a date range.
 *
 * Transfers stay out of the totals: moving money between your own accounts is
 * neither spending nor income.
 */
function aggregate(db: Db, start: string, end: string): Aggregate {
  const expenses = sum(
    db,
    "SELECT SUM(amount_cents) FROM transactions WHERE type='expense' AND date BETWEEN ? AND ?",
    [start, end],
  );
  const income = sum(
    db,
    "SELECT SUM(amount_cents) FROM transactions WHERE type='income' AND date BETWEEN ? AND ?",
    [start, end],
  );
  const count = sum(
    db,
    "SELECT COUNT(*) FROM transactions WHERE date BETWEEN ? AND ?",
    [start, end],
  );

  // Rolls up to the root category: a report with 40 subcategories is unreadable
  // on Telegram, and the root is the real unit of decision.
  const categoryRows = db
    .prepare(
      "SELECT COALESCE(cp.name, c.name, 'Sem categoria') AS category," +
        "       COALESCE(cp.emoji, c.emoji)              AS emoji," +
        "       SUM(t.amount_cents)                      AS total," +
        "       COUNT(*)                                 AS n " +
        "FROM transactions t " +
        "LEFT JOIN categories c  ON c.id = t.category_id " +
        "LEFT JOIN categories cp ON cp.id = c.parent_id " +
        "WHERE t.type = 'expense' AND t.date BETWEEN ? AND ? " +
        "GROUP BY category ORDER BY total DESC",
    )
    .all(start, end) as {
    category: string;
    emoji: string | null;
    total: number;
    n: number;
  }[];

  const accountRows = db
    .prepare(
      "SELECT COALESCE(a.name,'Sem conta') AS account, SUM(t.amount_cents) AS total, COUNT(*) AS n " +
        "FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id " +
        "WHERE t.type='expense' AND t.date BETWEEN ? AND ? GROUP BY account ORDER BY total DESC",
    )
    .all(start, end) as { account: string; total: number; n: number }[];

  const top = (
    db
      .prepare(
        "SELECT * FROM v_transactions WHERE type='expense' AND date BETWEEN ? AND ? " +
          "ORDER BY amount_cents DESC LIMIT 10",
      )
      .all(start, end) as TransactionRow[]
  ).map((r) => serializeTransaction(db, r));

  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
    ) + 1;

  return {
    expenses_cents: expenses,
    expenses_fmt: formatMoney(expenses),
    income_cents: income,
    income_fmt: formatMoney(income),
    net_cents: income - expenses,
    net_fmt: formatMoney(income - expenses),
    daily_average_fmt: days ? formatMoney(Math.trunc(expenses / days)) : formatMoney(0),
    days,
    count,
    by_category: categoryRows.map((r) => ({
      category: r.category,
      emoji: r.emoji,
      total_cents: r.total,
      total_fmt: formatMoney(r.total),
      count: r.n,
      pct: expenses ? Math.round((r.total * 1000) / expenses) / 10 : 0,
    })),
    by_account: accountRows.map((r) => ({
      account: r.account,
      total_cents: r.total,
      total_fmt: formatMoney(r.total),
      count: r.n,
    })),
    top_expenses: top,
  };
}

/**
 * The window immediately before, of the same length.
 *
 * For a full calendar month it returns the previous calendar month — not "31
 * days ago" — which is the comparison that makes sense in a monthly report.
 */
function previousWindow(start: string, end: string): { start: string; end: string } {
  const [, , startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);

  if (startDay === 1 && endDay === lastDayOfMonth(endYear, endMonth)) {
    const previousEnd = addDays(start, -1);
    const [y, m] = previousEnd.split("-").map(Number);
    return { start: `${y}-${String(m).padStart(2, "0")}-01`, end: previousEnd };
  }

  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
    ) + 1;
  const newEnd = addDays(start, -1);
  return { start: addDays(newEnd, -(days - 1)), end: newEnd };
}

export function cmdSummary(db: Db, a: Args): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const data: Output = { ...aggregate(db, p.start, p.end), period: p };

  if (!flag(a, "no-compare")) {
    const prev = previousWindow(p.start, p.end);
    const previous = aggregate(db, prev.start, prev.end);
    const current = data.expenses_cents as number;
    data.comparison = {
      previous_period: prev,
      previous_expenses_fmt: formatMoney(previous.expenses_cents),
      change_pct: previous.expenses_cents
        ? Math.round(((current - previous.expenses_cents) * 1000) / previous.expenses_cents) /
          10
        : null,
      difference_fmt: formatMoney(current - previous.expenses_cents),
    };
  }

  return data;
}

/**
 * A report in Portuguese, ready to send on Telegram.
 *
 * No markdown tables — Telegram does not render them. No space alignment — the
 * font is proportional and columns would come out crooked. One fact per line,
 * with an emoji as the visual anchor.
 */
export function cmdReport(db: Db, a: Args): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const r = aggregate(db, p.start, p.end);
  const prev = previousWindow(p.start, p.end);
  const previous = aggregate(db, prev.start, prev.end);
  const top = int(a, "top") ?? 8;

  const lines: string[] = [];
  // An em dash instead of "Resumo de %s": the labels do not all agree with the
  // same preposition in Portuguese ("de ontem" works, "de este mês" does not).
  lines.push(`📊 *${str(a, "title") ?? `Resumo — ${p.label}`}*`);
  lines.push(`_${shortDate(p.start)} a ${shortDate(p.end)}_`);
  lines.push("");
  lines.push(`💸 Gastos: *${r.expenses_fmt}*`);
  lines.push(`💰 Entradas: *${r.income_fmt}*`);

  const net = r.income_cents - r.expenses_cents;
  lines.push(`${net >= 0 ? "🟢" : "🔴"} Resultado: *${formatMoney(net)}*`);

  if (previous.expenses_cents) {
    const delta = r.expenses_cents - previous.expenses_cents;
    const pct = (Math.abs(delta) * 100) / previous.expenses_cents;
    if (pct < 1) {
      lines.push("➡️ Praticamente igual ao período anterior.");
    } else if (delta > 0) {
      lines.push(
        `📈 ${Math.round(pct)}% acima do período anterior (${formatMoney(delta)})`,
      );
    } else {
      lines.push(
        `📉 ${Math.round(pct)}% abaixo do período anterior (${formatMoney(-delta)})`,
      );
    }
  }

  if (r.by_category.length) {
    lines.push("");
    lines.push("*Onde o dinheiro foi:*");
    for (const c of r.by_category.slice(0, top)) {
      lines.push(`${c.emoji ?? "•"} ${c.category} — ${c.total_fmt} (${Math.round(c.pct)}%)`);
    }
    const rest = r.by_category.length - top;
    if (rest > 0) lines.push(`_... e ${rest} categoria(s) menor(es)_`);
  }

  if (r.top_expenses.length) {
    lines.push("");
    lines.push("*Maiores gastos:*");
    for (const g of r.top_expenses.slice(0, 5)) {
      lines.push(`• ${g.description} — ${g.amount_fmt} (${shortDate(g.date)})`);
    }
  }

  const budgets = budgetStatuses(db, monthOf(p.end));
  const over = budgets.filter((b) => b.pct >= 100);
  const nearing = budgets.filter((b) => b.pct < 100 && b.pct >= b.alert_pct);
  if (over.length || nearing.length) {
    lines.push("");
    lines.push("*Orçamentos:*");
    for (const b of over) {
      lines.push(
        `🔴 ${b.category} estourou: ${b.spent_fmt} de ${b.limit_fmt} (${Math.round(b.pct)}%)`,
      );
    }
    for (const b of nearing) {
      lines.push(
        `🟡 ${b.category} em ${Math.round(b.pct)}%: ${b.spent_fmt} de ${b.limit_fmt}`,
      );
    }
  }

  const text =
    r.count === 0
      ? [...lines.slice(0, 3), "Nenhum lançamento registrado neste período."].join("\n")
      : lines.join("\n");

  return {
    period: p,
    text,
    data: flag(a, "with-data") ? r : null,
  };
}

interface BudgetState {
  category_id: number | null;
  category: string;
  month: string;
  month_specific: boolean;
  limit_cents: number;
  limit_fmt: string;
  spent_cents: number;
  spent_fmt: string;
  remaining_cents: number;
  remaining_fmt: string;
  pct: number;
  alert_pct: number;
  status: BudgetStatus;
}

/**
 * Where each budget stands this month.
 *
 * A month-specific budget takes precedence over the recurring one (month NULL)
 * for the same category.
 */
function budgetStatuses(db: Db, month: string): BudgetState[] {
  const rows = db
    .prepare("SELECT * FROM budgets WHERE month IS NULL OR month = ? ORDER BY (month IS NULL)")
    .all(month) as {
    category_id: number | null;
    month: string | null;
    limit_cents: number;
    alert_pct: number;
  }[];

  const seen = new Set<number | null>();
  const states: BudgetState[] = [];

  for (const b of rows) {
    if (seen.has(b.category_id)) continue;
    seen.add(b.category_id);

    let spent: number;
    let name: string;
    if (b.category_id) {
      const ids = categoryAndChildrenIds(db, b.category_id);
      spent = sum(
        db,
        "SELECT SUM(amount_cents) FROM transactions WHERE type='expense' " +
          `AND substr(date,1,7) = ? AND category_id IN (${ids.map(() => "?").join(",")})`,
        [month, ...ids],
      );
      name = fullCategoryName(db, b.category_id);
    } else {
      spent = sum(
        db,
        "SELECT SUM(amount_cents) FROM transactions WHERE type='expense' AND substr(date,1,7) = ?",
        [month],
      );
      name = "Total do mês";
    }

    const limit = b.limit_cents;
    const pct = limit ? Math.round((spent * 1000) / limit) / 10 : 0;

    states.push({
      category_id: b.category_id,
      category: name,
      month,
      month_specific: b.month !== null,
      limit_cents: limit,
      limit_fmt: formatMoney(limit),
      spent_cents: spent,
      spent_fmt: formatMoney(spent),
      remaining_cents: limit - spent,
      remaining_fmt: formatMoney(limit - spent),
      pct,
      alert_pct: b.alert_pct,
      status: pct >= 100 ? "over" : pct >= b.alert_pct ? "warning" : "ok",
    });
  }

  states.sort((a, b) => b.pct - a.pct);
  return states;
}

/**
 * The budget covering this category (itself, its parent, or the global cap) —
 * what the agent needs right after recording the expense.
 */
function budgetForCategory(db: Db, categoryId: number, month: string): BudgetState | null {
  const row = db.prepare("SELECT parent_id FROM categories WHERE id = ?").get(categoryId) as
    | { parent_id: number | null }
    | undefined;

  const candidates = [categoryId];
  if (row?.parent_id) candidates.push(row.parent_id);

  const all = budgetStatuses(db, month);
  for (const candidate of candidates) {
    const found = all.find((b) => b.category_id === candidate);
    if (found) return found;
  }
  return all.find((b) => b.category_id === null) ?? null;
}

export function cmdBudget(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "status";
  const monthArg = str(a, "month");

  if (action === "set") {
    const limit = parseAmount(str(a, "limit"));
    const categoryId = str(a, "category") ? resolveCategory(db, str(a, "category")) : null;
    if (monthArg && !isValidMonth(monthArg)) {
      throw new FinError(`Mês inválido: ${monthArg}. Use YYYY-MM.`);
    }
    const alertPct = int(a, "alert") ?? 80;

    // Delete-then-insert rather than ON CONFLICT: in SQLite a UNIQUE with a NULL
    // column never conflicts (NULLs are distinct), so ON CONFLICT would never
    // fire for the global cap (category_id NULL) or a monthless budget, and each
    // `set` would create a duplicate. `IS` compares NULL correctly.
    transaction(db, () => {
      db.prepare("DELETE FROM budgets WHERE category_id IS ? AND month IS ?").run(
        categoryId,
        monthArg ?? null,
      );
      db.prepare(
        "INSERT INTO budgets (category_id, month, limit_cents, alert_pct, created_at) " +
          "VALUES (?,?,?,?,?)",
      ).run(categoryId, monthArg ?? null, limit, alertPct, now());
    });

    return {
      action: "set",
      target: categoryId ? fullCategoryName(db, categoryId) : "Total do mês",
      limit_fmt: formatMoney(limit),
      alert_pct: alertPct,
      status: budgetStatuses(db, monthArg ?? monthOf(today())),
    };
  }

  if (action === "rm") {
    const categoryId = str(a, "category") ? resolveCategory(db, str(a, "category")) : null;
    const info = db
      .prepare("DELETE FROM budgets WHERE category_id IS ? AND month IS ?")
      .run(categoryId, monthArg ?? null);
    if (!Number(info.changes)) {
      throw new FinError("Não havia orçamento definido para esse alvo.");
    }
    return { action: "removed", count: Number(info.changes) };
  }

  const month = monthArg ?? monthOf(today());
  const states = budgetStatuses(db, month);
  return {
    month,
    count: states.length,
    budgets: states,
    over_budget: states.filter((b) => b.pct >= 100),
  };
}

/**
 * Checks limits and returns only what deserves a notification.
 *
 * Built for cron: with nothing new, `silent` comes back true and the agent
 * replies `[SILENT]`, which Hermes treats as "deliver nothing". Without it the
 * bot would say "all good" several times a day.
 */
export function cmdAlerts(db: Db, a: Args): Output {
  const month = str(a, "month") ?? monthOf(today());
  const states = budgetStatuses(db, month);
  const mark = flag(a, "mark");
  const repeat = flag(a, "repeat");

  const alerts: Output[] = [];
  for (const b of states) {
    if (b.status === "ok") continue;
    const level = b.status;
    const key = `budget:${b.category_id ?? "global"}`;

    if (!repeat) {
      const already = db
        .prepare("SELECT 1 FROM sent_alerts WHERE key=? AND month=? AND level=?")
        .get(key, month, level);
      if (already) continue;
    }

    const pct = Math.round(b.pct);
    alerts.push({
      key,
      level,
      category: b.category,
      limit_fmt: b.limit_fmt,
      spent_fmt: b.spent_fmt,
      remaining_fmt: b.remaining_fmt,
      pct: b.pct,
      message:
        level === "over"
          ? `🔴 ${b.category} estourou o limite do mês: ${b.spent_fmt} de ${b.limit_fmt} (${pct}%).`
          : `🟡 ${b.category} já está em ${pct}% do limite: ${b.spent_fmt} de ${b.limit_fmt}. Restam ${b.remaining_fmt}.`,
    });
  }

  if (mark && alerts.length) {
    const ts = now();
    transaction(db, () => {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO sent_alerts (key, month, level, sent_at) VALUES (?,?,?,?)",
      );
      for (const al of alerts) insert.run(al.key as string, month, al.level as string, ts);
    });
  }

  return {
    month,
    silent: alerts.length === 0,
    count: alerts.length,
    alerts,
  };
}

export function cmdAccount(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const type = (str(a, "type") ?? "checking") as AccountType;
    if (!ACCOUNT_TYPES.includes(type)) {
      throw new FinError(`Tipo de conta inválido. Use um de: ${ACCOUNT_TYPES.join(", ")}.`);
    }
    try {
      const info = db
        .prepare(
          "INSERT INTO accounts (name, type, institution, closing_day, due_day," +
            " limit_cents, opening_balance_cents, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          name.trim(),
          type,
          str(a, "institution") ?? null,
          int(a, "closing") ?? null,
          int(a, "due") ?? null,
          str(a, "limit") ? parseAmount(str(a, "limit")) : null,
          str(a, "opening-balance") ? parseAmount(str(a, "opening-balance")) : 0,
          now(),
        );
      return { action: "created", id: Number(info.lastInsertRowid), name: name.trim() };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError(`Já existe uma conta chamada ${JSON.stringify(name)}.`);
      }
      throw e;
    }
  }

  if (action === "rm") {
    const accountId = resolveAccount(db, name, false)!;
    const uses = sum(
      db,
      "SELECT COUNT(*) FROM transactions WHERE account_id = ? OR dest_account_id = ?",
      [accountId, accountId],
    );
    // Deactivate instead of deleting: removing the account would take the
    // history attached to it.
    db.prepare("UPDATE accounts SET active = 0 WHERE id = ?").run(accountId);
    return { action: "deactivated", id: accountId, transactions_kept: uses };
  }

  if (action === "default") {
    const accountId = resolveAccount(db, name, false)!;
    const row = db.prepare("SELECT name FROM accounts WHERE id = ?").get(accountId) as {
      name: string;
    };
    setSetting(db, "default_account", row.name);
    return { action: "default_set", name: row.name };
  }

  return cmdBalance(db);
}

export function cmdCategory(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const parentId = str(a, "parent") ? resolveCategory(db, str(a, "parent")) : null;
    try {
      const info = db
        .prepare("INSERT INTO categories (name, parent_id, type, emoji) VALUES (?,?,?,?)")
        .run(name.trim(), parentId, str(a, "type") ?? "expense", str(a, "emoji") ?? null);
      const id = Number(info.lastInsertRowid);
      return { action: "created", id, name: fullCategoryName(db, id) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError("Essa categoria já existe nesse nível.");
      }
      throw e;
    }
  }

  if (action === "rm") {
    const categoryId = resolveCategory(db, name)!;
    db.prepare("UPDATE categories SET active = 0 WHERE id = ?").run(categoryId);
    return { action: "deactivated", id: categoryId };
  }

  const rows = db
    .prepare(
      "SELECT c.id, c.name, c.type, c.emoji, c.parent_id, p.name AS parent " +
        "FROM categories c LEFT JOIN categories p ON p.id = c.parent_id " +
        "WHERE c.active = 1 " +
        "ORDER BY COALESCE(p.name, c.name), (c.parent_id IS NOT NULL), c.name",
    )
    .all() as {
    id: number;
    name: string;
    type: string;
    emoji: string | null;
    parent_id: number | null;
    parent: string | null;
  }[];

  const tree: Record<
    string,
    { id: number | null; emoji: string | null; type: string | null; children: string[] }
  > = {};

  for (const r of rows) {
    if (r.parent_id === null) {
      tree[r.name] ??= { id: r.id, emoji: r.emoji, type: r.type, children: [] };
      tree[r.name].id = r.id;
      tree[r.name].emoji = r.emoji;
      tree[r.name].type = r.type;
    } else {
      const parent = r.parent!;
      tree[parent] ??= { id: null, emoji: null, type: null, children: [] };
      tree[parent].children.push(r.name);
    }
  }

  return { count: rows.length, categories: tree };
}

function advance(iso: string, frequency: string): string {
  if (frequency === "weekly") return addDays(iso, 7);
  if (frequency === "yearly") return addMonths(iso, 12);
  return addMonths(iso, 1);
}

/** The first upcoming (or today's) occurrence of a recurring entry. */
function nextOccurrence(frequency: string, day: number): string {
  const ref = today();
  const [year, month, dayToday] = ref.split("-").map(Number);

  if (frequency === "weekly") {
    // `day` = 0..6 (Monday..Sunday)
    const weekdayToday = (new Date(`${ref}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(ref, (day - weekdayToday + 7) % 7);
  }
  if (frequency === "yearly") return ref;

  const target = Math.min(Math.max(1, day), lastDayOfMonth(year, month));
  const thisMonth = `${year}-${String(month).padStart(2, "0")}-${String(target).padStart(2, "0")}`;
  return target >= dayToday ? thisMonth : addMonths(thisMonth, 1);
}

export function cmdRecurring(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "list";

  if (action === "add") {
    const description = str(a, "description");
    if (!description) throw new FinError("Informe --description.");
    const amount = parseAmount(str(a, "amount"));
    const frequency = str(a, "frequency") ?? "monthly";
    const day = int(a, "day") ?? 1;
    const next = nextOccurrence(frequency, day);

    const info = db
      .prepare(
        "INSERT INTO recurring (description, type, amount_cents, category_id, account_id," +
          " frequency, day, next_date, ends_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        description.trim(),
        str(a, "type") ?? "expense",
        amount,
        resolveCategory(db, str(a, "category"), true),
        resolveAccount(db, str(a, "account")),
        frequency,
        day,
        next,
        str(a, "ends") ? parseDate(str(a, "ends")) : null,
        now(),
      );

    return {
      action: "created",
      id: Number(info.lastInsertRowid),
      description: description.trim(),
      amount_fmt: formatMoney(amount),
      next_date: next,
    };
  }

  if (action === "rm") {
    const id = int(a, "id");
    if (id === undefined) throw new FinError("Informe --id.");
    const info = db.prepare("UPDATE recurring SET active = 0 WHERE id = ?").run(id);
    if (!Number(info.changes)) throw new FinError(`Não achei a recorrência #${id}.`);
    return { action: "deactivated", id };
  }

  if (action === "apply") {
    // Idempotent per (recurring, date): running twice in the same day does not
    // duplicate the rent.
    const todayIso = today();
    const due = db
      .prepare(
        "SELECT * FROM recurring WHERE active = 1 AND next_date <= ? " +
          "AND (ends_on IS NULL OR next_date <= ends_on)",
      )
      .all(todayIso) as {
      id: number;
      type: string;
      amount_cents: number;
      description: string;
      category_id: number | null;
      account_id: number | null;
      frequency: string;
      day: number;
      next_date: string;
      ends_on: string | null;
    }[];

    const generated: Output[] = [];
    const ts = now();

    for (const r of due) {
      let date = r.next_date;
      // Walk forward to today, covering the case of the bot being down for days.
      while (date <= todayIso) {
        if (r.ends_on && date > r.ends_on) break;
        const exists = db
          .prepare("SELECT 1 FROM transactions WHERE recurring_id = ? AND date = ?")
          .get(r.id, date);
        if (!exists) {
          const info = db
            .prepare(
              "INSERT INTO transactions (type, amount_cents, description, date, category_id," +
                " account_id, source, recurring_id, created_at, updated_at)" +
                " VALUES (?,?,?,?,?,?,'recurring',?,?,?)",
            )
            .run(
              r.type,
              r.amount_cents,
              r.description,
              date,
              r.category_id,
              r.account_id,
              r.id,
              ts,
              ts,
            );
          generated.push({
            id: Number(info.lastInsertRowid),
            description: r.description,
            date,
            amount_fmt: formatMoney(r.amount_cents),
          });
        }
        date = advance(date, r.frequency);
      }
      db.prepare("UPDATE recurring SET next_date = ? WHERE id = ?").run(date, r.id);
    }

    return {
      action: "applied",
      count: generated.length,
      generated,
      silent: generated.length === 0,
    };
  }

  const rows = db
    .prepare(
      "SELECT r.*, c.name AS category, a.name AS account FROM recurring r " +
        "LEFT JOIN categories c ON c.id = r.category_id " +
        "LEFT JOIN accounts a ON a.id = r.account_id " +
        "WHERE r.active = 1 ORDER BY r.next_date",
    )
    .all() as Record<string, unknown>[];

  let monthlyTotal = 0;
  const items = rows.map((r) => {
    if (r.frequency === "monthly" && r.type === "expense") {
      monthlyTotal += Number(r.amount_cents);
    }
    return { ...r, amount_fmt: formatMoney(Number(r.amount_cents)) };
  });

  return {
    count: items.length,
    monthly_fixed_total_fmt: formatMoney(monthlyTotal),
    recurring: items,
  };
}

function listGoals(db: Db): Output[] {
  const rows = db
    .prepare("SELECT * FROM goals WHERE active = 1 ORDER BY deadline IS NULL, deadline")
    .all() as {
    id: number;
    name: string;
    target_cents: number;
    saved_cents: number;
    deadline: string | null;
  }[];

  return rows.map((g) => {
    const pct = Math.round((g.saved_cents * 1000) / g.target_cents) / 10;
    const missing = g.target_cents - g.saved_cents;
    const item: Output = {
      id: g.id,
      name: g.name,
      target_fmt: formatMoney(g.target_cents),
      saved_fmt: formatMoney(g.saved_cents),
      missing_fmt: formatMoney(missing),
      pct,
      deadline: g.deadline,
      done: pct >= 100,
    };
    if (g.deadline) {
      const days = Math.round(
        (Date.parse(`${g.deadline}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) /
          86400000,
      );
      item.days_left = days;
      if (days > 0 && pct < 100) {
        item.monthly_needed_fmt = formatMoney(Math.trunc(missing / Math.max(1, days / 30)));
      }
    }
    return item;
  });
}

export function cmdGoal(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const target = parseAmount(str(a, "target"));
    try {
      const info = db
        .prepare(
          "INSERT INTO goals (name, target_cents, saved_cents, deadline, created_at)" +
            " VALUES (?,?,?,?,?)",
        )
        .run(
          name.trim(),
          target,
          str(a, "initial") ? parseAmount(str(a, "initial")) : 0,
          str(a, "deadline") ? parseDate(str(a, "deadline")) : null,
          now(),
        );
      return { action: "created", id: Number(info.lastInsertRowid), target_fmt: formatMoney(target) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError("Já existe uma meta com esse nome.");
      }
      throw e;
    }
  }

  if (action === "deposit") {
    const amount = parseAmount(str(a, "amount"));
    const row = db
      .prepare("SELECT * FROM goals WHERE name = ? COLLATE NOCASE AND active = 1")
      .get(name ?? "") as { id: number; name: string } | undefined;
    if (!row) throw new FinError(`Não achei a meta ${JSON.stringify(name)}.`);
    db.prepare("UPDATE goals SET saved_cents = saved_cents + ? WHERE id = ?").run(
      amount,
      row.id,
    );
    return {
      action: "deposited",
      goal: row.name,
      deposit_fmt: formatMoney(amount),
      goals: listGoals(db),
    };
  }

  if (action === "rm") {
    const info = db
      .prepare("UPDATE goals SET active = 0 WHERE name = ? COLLATE NOCASE")
      .run(name ?? "");
    if (!Number(info.changes)) {
      throw new FinError(`Não achei a meta ${JSON.stringify(name)}.`);
    }
    return { action: "removed", name };
  }

  return { goals: listGoals(db) };
}

function csvField(value: unknown): string {
  const s = String(value ?? "");
  return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Exports the period's transactions.
 *
 * CSV uses `;` and a decimal comma, written UTF-8 with a BOM: that is what makes
 * Excel in Portuguese open it with the right columns and the numbers recognised
 * as numbers, with no import step.
 */
export function cmdExport(db: Db, a: Args, dbPath: string): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const format = str(a, "format") ?? "csv";
  if (!["csv", "json", "md"].includes(format)) {
    throw new FinError(`Formato inválido: ${format}. Use csv, json ou md.`);
  }

  const items = (
    db
      .prepare("SELECT * FROM v_transactions WHERE date BETWEEN ? AND ? ORDER BY date, id")
      .all(p.start, p.end) as TransactionRow[]
  ).map((r) => serializeTransaction(db, r));

  const destDir = str(a, "dest") ?? join(dirname(resolve(dbPath)), "exports");
  mkdirSync(destDir, { recursive: true });
  // The column headers below stay Portuguese — they are what the user reads in
  // Excel — but the filename carries the product name, matching the backups.
  const base = `tally-${p.start}-a-${p.end}`;

  let path: string;
  if (format === "json") {
    path = join(destDir, `${base}.json`);
    writeFileSync(path, JSON.stringify(items, null, 2), "utf8");
  } else if (format === "md") {
    path = join(destDir, `${base}.md`);
    const lines = [
      `# Lançamentos — ${fullDate(p.start)} a ${fullDate(p.end)}`,
      "",
      "| Data | Tipo | Descrição | Categoria | Conta | Valor |",
      "|---|---|---|---|---|---|",
      ...items.map(
        (i) =>
          `| ${fullDate(i.date)} | ${i.type} | ${i.description.replaceAll("|", "/")} ` +
          `| ${i.full_category} | ${i.account} | ${i.amount_fmt} |`,
      ),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  } else {
    path = join(destDir, `${base}.csv`);
    const lines = [
      [
        "id", "data", "tipo", "descricao", "categoria", "subcategoria",
        "conta", "valor", "parcela", "tags", "observacao",
      ].join(";"),
      ...items.map((i) =>
        [
          i.id,
          fullDate(i.date),
          i.type,
          i.description,
          i.parent_category ?? i.category,
          i.parent_category ? i.category : "",
          i.account,
          (i.amount_cents / 100).toFixed(2).replace(".", ","),
          i.installment ?? "",
          i.tags.join(", "),
          i.note ?? "",
        ]
          .map(csvField)
          .join(";"),
      ),
    ];
    // BOM + CRLF: what Excel expects.
    writeFileSync(path, `﻿${lines.join("\r\n")}\r\n`, "utf8");
  }

  return { file: path, format, period: p, count: items.length };
}

type OptionType = "string" | "boolean";

const COMMON_OPTIONS: Record<string, OptionType> = {
  amount: "string",
  description: "string",
  category: "string",
  account: "string",
  date: "string",
  type: "string",
  tags: "string",
  note: "string",
};

const SPECS: Record<string, Record<string, OptionType>> = {
  init: {},
  add: {
    ...COMMON_OPTIONS,
    "dest-account": "string",
    installments: "string",
    source: "string",
  },
  edit: COMMON_OPTIONS,
  rm: { group: "boolean" },
  ls: {
    period: "string",
    category: "string",
    account: "string",
    type: "string",
    tag: "string",
    text: "string",
    limit: "string",
    order: "string",
  },
  search: { limit: "string" },
  balance: {},
  summary: { period: "string", "no-compare": "boolean" },
  report: {
    period: "string",
    title: "string",
    top: "string",
    "with-data": "boolean",
  },
  budget: {
    category: "string",
    limit: "string",
    month: "string",
    alert: "string",
  },
  alerts: { month: "string", mark: "boolean", repeat: "boolean" },
  account: {
    name: "string",
    type: "string",
    institution: "string",
    closing: "string",
    due: "string",
    limit: "string",
    "opening-balance": "string",
  },
  category: { name: "string", parent: "string", type: "string", emoji: "string" },
  recurring: {
    id: "string",
    description: "string",
    amount: "string",
    category: "string",
    account: "string",
    type: "string",
    frequency: "string",
    day: "string",
    ends: "string",
  },
  goal: {
    name: "string",
    target: "string",
    amount: "string",
    initial: "string",
    deadline: "string",
  },
  export: { period: "string", format: "string", dest: "string" },
};

const USAGE = `Personal finance ledger. Every command prints JSON.

  node fin.ts [--db PATH] <subcommand> [options]

Subcommands: ${Object.keys(SPECS).join(", ")}

Examples:
  node fin.ts add --amount 27 --description "Uber" --category "Uber/99"
  node fin.ts summary --period month
  node fin.ts report --period last-month
  node fin.ts budget set --category Alimentação --limit 500
`;

export function main(argv: string[]): number {
  // --db is global: pull it out before choosing the subcommand's spec.
  let dbPath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      dbPath = argv[++i];
    } else if (argv[i].startsWith("--db=")) {
      dbPath = argv[i].slice(5);
    } else {
      rest.push(argv[i]);
    }
  }

  const command = rest[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  try {
    if (!(command in SPECS)) {
      throw new FinError(
        `Subcomando desconhecido: ${command}. Use um de: ${Object.keys(SPECS).join(", ")}.`,
      );
    }

    const spec = SPECS[command];
    let values: Args;
    let positionals: string[];
    try {
      const parsed = parseArgs({
        args: rest.slice(1),
        options: Object.fromEntries(
          Object.entries(spec).map(([k, t]) => [k, { type: t }]),
        ) as never,
        allowPositionals: true,
        strict: true,
      });
      values = parsed.values as Args;
      positionals = parsed.positionals;
    } catch (e) {
      // Turn parseArgs' technical error into something the agent can act on and
      // relay to the user.
      throw new FinError(
        `${(e as Error).message}. Opções aceitas em \`${command}\`: ` +
          `${Object.keys(spec).map((k) => `--${k}`).join(", ") || "nenhuma"}.`,
      );
    }

    const target = dbPath ?? process.env.TALLY_DB;
    let output: Output;

    if (command === "init") {
      output = init(target) as unknown as Output;
    } else {
      const db = connect(target);
      try {
        // Auto-migrate: any command works against a fresh database, with no
        // manual `init` first.
        if (currentVersion(db) < CURRENT_SCHEMA_VERSION) {
          migrate(db);
          seed(db);
        }

        switch (command) {
          case "add": output = cmdAdd(db, values); break;
          case "edit": output = cmdEdit(db, values, positionals); break;
          case "rm": output = cmdRm(db, values, positionals); break;
          case "ls": output = cmdLs(db, values); break;
          case "search": output = cmdSearch(db, values, positionals); break;
          case "balance": output = cmdBalance(db); break;
          case "summary": output = cmdSummary(db, values); break;
          case "report": output = cmdReport(db, values); break;
          case "budget": output = cmdBudget(db, values, positionals); break;
          case "alerts": output = cmdAlerts(db, values); break;
          case "account": output = cmdAccount(db, values, positionals); break;
          case "category": output = cmdCategory(db, values, positionals); break;
          case "recurring": output = cmdRecurring(db, values, positionals); break;
          case "goal": output = cmdGoal(db, values, positionals); break;
          case "export":
            output = cmdExport(db, values, target ?? "/opt/data/finance/tally.db");
            break;
          default:
            throw new FinError(`Subcomando não implementado: ${command}.`);
        }
      } finally {
        db.close();
      }
    }

    process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
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
