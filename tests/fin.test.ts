/**
 * Tests for the finance CLI.
 *
 * They run with no credentials, no container and no network, which is what lets
 * the bot be validated before there is an OpenRouter key or a Telegram token.
 *
 * The focus is where a bug would corrupt months of data without showing up:
 * cent arithmetic, calendar boundaries, category hierarchy inside budgets, and
 * idempotency of recurring entries.
 *
 *     node --test tests/fin.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FinError,
  addDays,
  cents,
  formatMoney,
  monthOf,
  parseAmount,
  parseDate,
  periodRange,
  today,
} from "../skills/finance/scripts/db.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "skills", "finance", "scripts", "fin.ts");

interface Response {
  ok: boolean;
  error?: string;
  _exit: number;
  [k: string]: unknown;
}

/**
 * Runs the CLI the way the agent runs it — as a subprocess.
 *
 * Testing through the process rather than importing the functions is what keeps
 * the output contract and the exit codes covered too.
 */
function run(db: string, ...args: string[]): Response {
  const proc = spawnSync(process.execPath, [CLI, "--db", db, ...args], {
    encoding: "utf8",
  });
  assert.ok(proc.stdout, `no output. stderr: ${proc.stderr}`);
  return { ...JSON.parse(proc.stdout), _exit: proc.status ?? -1 };
}

function ok(db: string, ...args: string[]): Response {
  const r = run(db, ...args);
  assert.equal(r.ok, true, `expected success, got: ${r.error}`);
  assert.equal(r._exit, 0);
  return r;
}

function fails(db: string, ...args: string[]): string {
  const r = run(db, ...args);
  assert.equal(r.ok, false, "expected a failure, got success");
  assert.equal(r._exit, 1);
  return r.error!;
}

/** A fresh, initialised database. */
function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "tally-test-"));
  const path = join(dir, "tally.db");
  ok(path, "init");
  return path;
}

const tx = (r: Response) => r.transaction as Record<string, never>;
const installments = (r: Response) => r.installments as Record<string, never>[];

describe("amounts", () => {
  const cases: [unknown, number][] = [
    [27, 2700],
    [27.5, 2750],
    ["27", 2700],
    ["27,50", 2750],
    ["27.50", 2750],
    ["1.234,56", 123456],
    ["R$ 1.234,56", 123456],
    ["r$27", 2700],
    ["1234.56", 123456],
    ["1.234", 123400],
    ["1,2k", 120000],
    ["2k", 200000],
    ["2 mil", 200000],
    ["30 reais", 3000],
    ["0,99", 99],
    ["-50", 5000],
  ];
  for (const [input, expected] of cases) {
    test(`parseAmount(${JSON.stringify(input)}) = ${expected}`, () => {
      assert.equal(parseAmount(input), expected);
    });
  }

  for (const bad of ["", "abc", null, undefined, 0, "0", "R$", true]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseAmount(bad), FinError);
    });
  }

  const formats: [number, string][] = [
    [0, "R$ 0,00"],
    [5, "R$ 0,05"],
    [2700, "R$ 27,00"],
    [123456, "R$ 1.234,56"],
    [100000000, "R$ 1.000.000,00"],
    [-2700, "-R$ 27,00"],
  ];
  for (const [value, text] of formats) {
    test(`formatMoney(${value}) = ${text}`, () => {
      assert.equal(formatMoney(cents(value)), text);
    });
  }

  test("no floating-point drift across a hundred additions", () => {
    // 0.10 added a hundred times must come to exactly R$ 10,00. This is why
    // money is an integer here: with floats it would be 9.999999999999998.
    const db = freshDb();
    for (let i = 0; i < 100; i++) {
      ok(db, "add", "--amount", "0,10", "--description", `café ${i}`, "--category", "Café");
    }
    const r = ok(db, "summary", "--period", "month");
    assert.equal(r.expenses_cents, 1000);
    assert.equal(r.expenses_fmt, "R$ 10,00");
  });
});

describe("dates", () => {
  test("relative words, in both languages", () => {
    assert.equal(parseDate("today"), today());
    assert.equal(parseDate("hoje"), today());
    assert.equal(parseDate("yesterday"), addDays(today(), -1));
    assert.equal(parseDate("ontem"), addDays(today(), -1));
    assert.equal(parseDate("anteontem"), addDays(today(), -2));
    assert.equal(parseDate(null), today());
    assert.equal(parseDate(""), today());
    assert.equal(parseDate(undefined), today());
  });

  test("explicit formats are day-first", () => {
    assert.equal(parseDate("2026-03-15"), "2026-03-15");
    assert.equal(parseDate("15/03/2026"), "2026-03-15");
    assert.equal(parseDate("15-03-2026"), "2026-03-15");
    assert.equal(parseDate("15/03/26"), "2026-03-15");
  });

  test("DD/MM assumes the current year", () => {
    const [year, month] = today().split("-");
    assert.equal(parseDate(`01/${month}`), `${year}-${month}-01`);
  });

  test("DD/MM far in the future falls back a year", () => {
    // A date that would land more than a month ahead was actually last year —
    // the case of logging "28/12" in January.
    const future = addDays(today(), 90);
    const [, month, day] = future.split("-");
    assert.ok(parseDate(`${day}/${month}`) <= addDays(today(), 31));
  });

  test("day N of the current month", () => {
    const [year, month] = today().split("-");
    assert.equal(parseDate("dia 1"), `${year}-${month}-01`);
    assert.equal(parseDate("day 1"), `${year}-${month}-01`);
  });

  test("non-existent dates are rejected", () => {
    assert.throws(() => parseDate("31/02/2026"), FinError);
    assert.throws(() => parseDate("2026-13-01"), FinError);
    assert.throws(() => parseDate("2026-02-30"), FinError);
    assert.throws(() => parseDate("whenever"), FinError);
  });

  const periods = ["today", "yesterday", "week", "last-week", "month", "last-month",
    "full-month", "year", "last-year", "30d", "7d", "2026-03", "all"];
  for (const p of periods) {
    test(`period ${p}`, () => {
      const r = periodRange(p);
      assert.ok(r.start <= r.end, `${r.start} > ${r.end}`);
      assert.ok(r.label);
    });
  }

  test("unknown period", () => {
    assert.throws(() => periodRange("lunar fortnight"), FinError);
  });

  test("calendar month ends on the right day", () => {
    const feb = periodRange("2026-02");
    assert.equal(feb.start, "2026-02-01");
    assert.equal(feb.end, "2026-02-28");
  });

  test("leap year", () => {
    assert.equal(periodRange("2028-02").end, "2028-02-29");
  });

  test("weeks start on Monday", () => {
    const r = periodRange("week", "2026-08-05"); // a Wednesday
    assert.equal(r.start, "2026-08-03");
  });

  test("period labels are Portuguese, since they land in report titles", () => {
    assert.equal(periodRange("month").label, "este mês");
    assert.equal(periodRange("last-month").label, "mês passado");
  });

  test("monthOf", () => {
    assert.equal(monthOf("2026-08-03"), "2026-08");
  });
});

describe("transactions", () => {
  test("add with only the essentials uses the defaults", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "27", "--description", "Uber");
    const t = tx(r);
    assert.equal(t.type, "expense");
    assert.equal(t.date, today());
    assert.equal(t.account, "Carteira");
    assert.equal(r.id, t.id);
  });

  test("description is required", () => {
    const db = freshDb();
    assert.match(fails(db, "add", "--amount", "10", "--description", "  "), /Descrição/);
  });

  test("an unknown category is created instead of failing", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "50", "--description", "Curso",
      "--category", "Cerâmica artesanal");
    assert.match(String(tx(r).full_category), /Cerâmica artesanal/);
  });

  test("category matching ignores accents and case", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "20", "--description", "Almoço",
      "--category", "ALIMENTACAO");
    assert.equal(tx(r).category, "Alimentação");
  });

  test("a subcategory wins over its parent", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "35", "--description", "iFood",
      "--category", "Delivery");
    assert.equal(tx(r).category, "Delivery");
    assert.equal(tx(r).parent_category, "Alimentação");
  });

  test("an unknown account fails with a clear message", () => {
    const db = freshDb();
    assert.match(
      fails(db, "add", "--amount", "10", "--description", "x", "--account", "Banco Fantasma"),
      /não existe/,
    );
  });

  test("tags", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "80", "--description", "Jantar",
      "--category", "Restaurante", "--tags", "trabalho, reembolsável");
    assert.deepEqual(tx(r).tags, ["reembolsável", "trabalho"]);
  });

  test("edit changes only what was passed", () => {
    const db = freshDb();
    const created = ok(db, "add", "--amount", "27", "--description", "Uber",
      "--category", "Uber/99");
    const r = ok(db, "edit", String(created.id), "--amount", "37");
    assert.equal(tx(r).amount_cents, 3700);
    assert.equal(tx(r).description, "Uber");
    assert.equal(tx(r).category, "Uber/99");
  });

  test("edit with no fields fails", () => {
    const db = freshDb();
    const created = ok(db, "add", "--amount", "10", "--description", "x");
    assert.match(fails(db, "edit", String(created.id)), /Nada para alterar/);
  });

  test("edit of an unknown id", () => {
    const db = freshDb();
    assert.match(fails(db, "edit", "999", "--amount", "10"), /#999/);
  });

  test("rm", () => {
    const db = freshDb();
    const created = ok(db, "add", "--amount", "10", "--description", "typo");
    ok(db, "rm", String(created.id));
    assert.equal(ok(db, "ls", "--period", "month").total_count, 0);
  });

  test("a transfer needs a destination", () => {
    const db = freshDb();
    assert.match(
      fails(db, "add", "--type", "transfer", "--amount", "100", "--description", "x"),
      /dest-account/,
    );
  });

  test("a transfer counts as neither expense nor income", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Poupança", "--type", "savings");
    ok(db, "add", "--type", "transfer", "--amount", "500", "--description", "Guardar",
      "--account", "Carteira", "--dest-account", "Poupança");
    const r = ok(db, "summary", "--period", "month");
    assert.equal(r.expenses_cents, 0);
    assert.equal(r.income_cents, 0);
  });

  test("a transfer moves the balance between accounts", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Poupança", "--type", "savings");
    ok(db, "add", "--type", "income", "--amount", "1000", "--description", "Entrada",
      "--account", "Carteira", "--category", "Salário");
    ok(db, "add", "--type", "transfer", "--amount", "400", "--description", "Guardar",
      "--account", "Carteira", "--dest-account", "Poupança");
    const rows = ok(db, "balance").accounts as { name: string; balance_cents: number }[];
    const balances = Object.fromEntries(rows.map((c) => [c.name, c.balance_cents]));
    assert.equal(balances["Carteira"], 60000);
    assert.equal(balances["Poupança"], 40000);
  });

  test("a transfer to the same account fails", () => {
    const db = freshDb();
    assert.match(
      fails(db, "add", "--type", "transfer", "--amount", "10", "--description", "x",
        "--account", "Carteira", "--dest-account", "Carteira"),
      /mesma/,
    );
  });

  test("an invalid type is rejected", () => {
    const db = freshDb();
    assert.match(
      fails(db, "add", "--amount", "10", "--description", "x", "--type", "withdrawal"),
      /Tipo inválido/,
    );
  });

  test("an unknown option reports the accepted ones", () => {
    const db = freshDb();
    const message = fails(db, "add", "--amount", "10", "--description", "x", "--currency", "USD");
    assert.match(message, /--category/);
  });
});

describe("instalments", () => {
  test("spread over consecutive months", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "1200", "--description", "Notebook",
      "--category", "Eletrônicos", "--installments", "3", "--date", "2026-01-15");
    assert.deepEqual(installments(r).map((p) => p.date),
      ["2026-01-15", "2026-02-15", "2026-03-15"]);
    assert.ok(installments(r).every((p) => p.amount_cents === 40000));
  });

  test("no cent is lost when splitting", () => {
    // R$ 100,00 in 3x is 33.34 + 33.33 + 33.33. The sum has to add up.
    const db = freshDb();
    const r = ok(db, "add", "--amount", "100", "--description", "Curso",
      "--category", "Curso", "--installments", "3");
    const values = installments(r).map((p) => Number(p.amount_cents));
    assert.equal(values.reduce((a, b) => a + b, 0), 10000);
    assert.deepEqual(values, [3334, 3333, 3333]);
  });

  test("a day that does not exist next month is clamped", () => {
    // Jan 31 + 1 month = Feb 28, not an invalid date.
    const db = freshDb();
    const r = ok(db, "add", "--amount", "300", "--description", "Parcelado",
      "--category", "Compras", "--installments", "3", "--date", "2026-01-31");
    assert.deepEqual(installments(r).map((p) => p.date),
      ["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  test("rm --group deletes the whole series", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "900", "--description", "TV",
      "--category", "Eletrônicos", "--installments", "3");
    assert.equal(ok(db, "rm", String(installments(r)[0].id), "--group").count, 3);
  });

  test("rm without --group deletes only one instalment", () => {
    const db = freshDb();
    const r = ok(db, "add", "--amount", "900", "--description", "TV",
      "--category", "Eletrônicos", "--installments", "3");
    assert.equal(ok(db, "rm", String(installments(r)[0].id)).count, 1);
  });

  test("instalment count out of range", () => {
    const db = freshDb();
    assert.match(
      fails(db, "add", "--amount", "10", "--description", "x", "--installments", "200"),
      /parcelas/,
    );
  });
});

describe("budgets", () => {
  test("spending in a subcategory counts against the parent's budget", () => {
    // A limit on "Alimentação" has to capture what was logged under "Delivery",
    // or the parent's cap would never add up to the sum of its parts.
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Alimentação", "--limit", "500");
    ok(db, "add", "--amount", "120", "--description", "iFood", "--category", "Delivery");
    ok(db, "add", "--amount", "80", "--description", "Mercado", "--category", "Mercado");
    const b = (ok(db, "budget", "status").budgets as
      { spent_cents: number; pct: number }[])[0];
    assert.equal(b.spent_cents, 20000);
    assert.equal(b.pct, 40);
  });

  test("the global cap sums everything", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--limit", "1000");
    ok(db, "add", "--amount", "300", "--description", "a", "--category", "Mercado");
    ok(db, "add", "--amount", "200", "--description", "b", "--category", "Uber/99");
    const b = (ok(db, "budget", "status").budgets as
      { category: string; spent_cents: number }[])[0];
    assert.equal(b.category, "Total do mês");
    assert.equal(b.spent_cents, 50000);
  });

  test("setting twice does not duplicate", () => {
    // SQLite's UNIQUE does not catch NULL, so this was a real bug once.
    const db = freshDb();
    for (const limit of ["1000", "2000", "3000"]) {
      ok(db, "budget", "set", "--limit", limit);
    }
    const list = ok(db, "budget", "status").budgets as { limit_cents: number }[];
    assert.equal(list.length, 1);
    assert.equal(list[0].limit_cents, 300000);
  });

  test("a month-specific budget wins over the recurring one", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "200");
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "800", "--month", monthOf(today()));
    const b = (ok(db, "budget", "status").budgets as
      { limit_cents: number; month_specific: boolean }[])[0];
    assert.equal(b.limit_cents, 80000);
    assert.equal(b.month_specific, true);
  });

  test("statuses: ok / warning / over", () => {
    const db = freshDb();
    const status = () =>
      (ok(db, "budget", "status").budgets as { status: string }[])[0].status;

    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100", "--alert", "80");
    ok(db, "add", "--amount", "50", "--description", "Bar", "--category", "Bar");
    assert.equal(status(), "ok");
    ok(db, "add", "--amount", "35", "--description", "Cinema", "--category", "Cinema");
    assert.equal(status(), "warning");
    ok(db, "add", "--amount", "30", "--description", "Show", "--category", "Eventos");
    assert.equal(status(), "over");
  });

  test("add returns the budget it affected", () => {
    // So the agent can warn in the same reply, with no second call.
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Alimentação", "--limit", "100");
    const r = ok(db, "add", "--amount", "95", "--description", "Mercado", "--category", "Mercado");
    const b = r.budget as { status: string; pct: number };
    assert.equal(b.status, "warning");
    assert.equal(b.pct, 95);
  });

  test("rm budget", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100");
    ok(db, "budget", "rm", "--category", "Lazer");
    assert.equal(ok(db, "budget", "status").count, 0);
  });

  test("invalid month", () => {
    const db = freshDb();
    assert.match(
      fails(db, "budget", "set", "--limit", "100", "--month", "agosto"),
      /Mês inválido/,
    );
  });
});

describe("alerts", () => {
  test("stays silent when everything is fine", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "1000");
    ok(db, "add", "--amount", "10", "--description", "Bar", "--category", "Bar");
    const r = ok(db, "alerts");
    assert.equal(r.silent, true);
    assert.deepEqual(r.alerts, []);
  });

  test("does not repeat the same alert within a month", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100");
    ok(db, "add", "--amount", "150", "--description", "Show", "--category", "Eventos");

    const first = ok(db, "alerts", "--mark");
    assert.equal(first.count, 1);
    assert.equal((first.alerts as { level: string }[])[0].level, "over");

    assert.equal(ok(db, "alerts").silent, true);
    assert.equal(ok(db, "alerts", "--repeat").count, 1);
  });

  test("going from warning to over is a new alert", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100", "--alert", "70");
    ok(db, "add", "--amount", "75", "--description", "Bar", "--category", "Bar");
    assert.equal((ok(db, "alerts", "--mark").alerts as { level: string }[])[0].level, "warning");

    ok(db, "add", "--amount", "40", "--description", "Show", "--category", "Eventos");
    const r = ok(db, "alerts", "--mark");
    assert.equal(r.count, 1);
    assert.equal((r.alerts as { level: string }[])[0].level, "over");
  });

  test("alert messages are Portuguese, since the agent forwards them", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100");
    ok(db, "add", "--amount", "150", "--description", "Show", "--category", "Eventos");
    const message = (ok(db, "alerts").alerts as { message: string }[])[0].message;
    assert.match(message, /estourou o limite do mês/);
  });
});

describe("reports", () => {
  test("summary rolls up to the root category", () => {
    const db = freshDb();
    ok(db, "add", "--amount", "100", "--description", "iFood", "--category", "Delivery");
    ok(db, "add", "--amount", "50", "--description", "Mercado", "--category", "Mercado");
    ok(db, "add", "--amount", "30", "--description", "Uber", "--category", "Uber/99");
    const r = ok(db, "summary", "--period", "month");
    const byCategory = Object.fromEntries(
      (r.by_category as { category: string; total_cents: number }[]).map((c) => [
        c.category,
        c.total_cents,
      ]),
    );
    assert.deepEqual(byCategory, { "Alimentação": 15000, Transporte: 3000 });
  });

  test("percentages add up to a hundred", () => {
    const db = freshDb();
    for (const [amount, category] of [["100", "Mercado"], ["200", "Uber/99"], ["300", "Bar"]]) {
      ok(db, "add", "--amount", amount, "--description", "x", "--category", category);
    }
    const r = ok(db, "summary", "--period", "month");
    const total = (r.by_category as { pct: number }[]).reduce((a, c) => a + c.pct, 0);
    assert.equal(Math.round(total), 100);
  });

  test("a calendar month compares against the previous calendar month", () => {
    const db = freshDb();
    ok(db, "add", "--amount", "100", "--description", "jan", "--category", "Mercado",
      "--date", "2026-01-10");
    ok(db, "add", "--amount", "200", "--description", "fev", "--category", "Mercado",
      "--date", "2026-02-10");
    const r = ok(db, "summary", "--period", "2026-02");
    assert.equal(r.expenses_cents, 20000);
    const c = r.comparison as { previous_expenses_fmt: string; change_pct: number };
    assert.equal(c.previous_expenses_fmt, "R$ 100,00");
    assert.equal(c.change_pct, 100);
  });

  test("report produces Portuguese text for Telegram", () => {
    const db = freshDb();
    ok(db, "add", "--amount", "100", "--description", "Mercado", "--category", "Mercado");
    const text = ok(db, "report", "--period", "month").text as string;
    assert.match(text, /Gastos/);
    assert.match(text, /R\$ 100,00/);
    // No markdown table: Telegram does not render them.
    assert.doesNotMatch(text, /\|---/);
  });

  test("a report over an empty period does not break", () => {
    const db = freshDb();
    const text = ok(db, "report", "--period", "2020-01").text as string;
    assert.match(text, /Nenhum lançamento/);
  });

  test("daily average", () => {
    const db = freshDb();
    ok(db, "add", "--amount", "310", "--description", "x", "--category", "Mercado",
      "--date", "2026-01-15");
    const r = ok(db, "summary", "--period", "2026-01");
    assert.equal(r.days, 31);
    assert.equal(r.daily_average_fmt, "R$ 10,00");
  });
});

describe("recurring", () => {
  test("apply is idempotent", () => {
    // Running twice in the same day must not duplicate the rent.
    const db = freshDb();
    const yesterday = addDays(today(), -1);
    ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", yesterday.slice(8));

    const first = ok(db, "recurring", "apply");
    const second = ok(db, "recurring", "apply");
    assert.equal(second.count, 0);
    assert.equal(second.silent, true);
    assert.equal(ok(db, "ls", "--period", "all").total_count, first.count);
  });

  test("adding one does not backfill the current period", () => {
    // Registering a day-1 entry today must not invent this month's charge — it
    // was most likely already logged by hand.
    const db = freshDb();
    if (Number(today().slice(8)) <= 1) return;
    const r = ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", "1");
    assert.ok(String(r.next_date) > today());
    assert.equal(ok(db, "recurring", "apply").count, 0);
  });

  test("monthly fixed total", () => {
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Netflix", "--amount", "44,90",
      "--category", "Streaming", "--day", "5");
    ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", "10");
    assert.equal(ok(db, "recurring", "list").monthly_fixed_total_fmt, "R$ 1.544,90");
  });

  test("deactivate", () => {
    const db = freshDb();
    const r = ok(db, "recurring", "add", "--description", "Spotify", "--amount", "22",
      "--category", "Streaming", "--day", "3");
    ok(db, "recurring", "rm", "--id", String(r.id));
    assert.equal(ok(db, "recurring", "list").count, 0);
  });
});

describe("goals", () => {
  test("progress and the monthly deposit needed", () => {
    const db = freshDb();
    ok(db, "goal", "add", "--name", "Viagem", "--target", "15000", "--initial", "3000",
      "--deadline", addDays(today(), 300));
    const goal = (ok(db, "goal", "deposit", "--name", "viagem", "--amount", "1000")
      .goals as Record<string, unknown>[])[0];
    assert.equal(goal.saved_fmt, "R$ 4.000,00");
    assert.equal(goal.pct, 26.7);
    assert.equal(goal.missing_fmt, "R$ 11.000,00");
    assert.ok(goal.monthly_needed_fmt);
  });

  test("completion", () => {
    const db = freshDb();
    ok(db, "goal", "add", "--name", "Reserva", "--target", "1000");
    const goal = (ok(db, "goal", "deposit", "--name", "Reserva", "--amount", "1000")
      .goals as { done: boolean }[])[0];
    assert.equal(goal.done, true);
  });

  test("duplicate name", () => {
    const db = freshDb();
    ok(db, "goal", "add", "--name", "Reserva", "--target", "1000");
    assert.match(fails(db, "goal", "add", "--name", "Reserva", "--target", "2000"), /Já existe/);
  });

  test("deposit into an unknown goal", () => {
    const db = freshDb();
    assert.match(fails(db, "goal", "deposit", "--name", "Fantasma", "--amount", "10"),
      /Não achei/);
  });
});

describe("accounts", () => {
  test("a card shows the month's bill and limit usage", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Nubank", "--type", "card",
      "--due", "10", "--limit", "5000");
    ok(db, "add", "--amount", "300", "--description", "Compra", "--category", "Compras",
      "--account", "Nubank");
    const card = (ok(db, "balance").accounts as Record<string, unknown>[])
      .find((c) => c.name === "Nubank")!;
    assert.equal(card.month_bill_fmt, "R$ 300,00");
    assert.equal(card.limit_used_pct, 6);
    // Negative means you owe.
    assert.equal(card.balance_cents, -30000);
  });

  test("opening balance", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Itaú", "--opening-balance", "1000");
    const account = (ok(db, "balance").accounts as Record<string, unknown>[])
      .find((c) => c.name === "Itaú")!;
    assert.equal(account.balance_cents, 100000);
  });

  test("duplicate name", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Itaú");
    assert.match(fails(db, "account", "add", "--name", "Itaú"), /Já existe/);
  });

  test("deactivating keeps the history", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Antiga");
    ok(db, "add", "--amount", "50", "--description", "x", "--category", "Mercado",
      "--account", "Antiga");
    const r = ok(db, "account", "rm", "--name", "Antiga");
    assert.equal(r.transactions_kept, 1);
    assert.equal(ok(db, "ls", "--period", "month").total_count, 1);
  });

  test("default account", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Inter");
    ok(db, "account", "default", "--name", "Inter");
    const r = ok(db, "add", "--amount", "10", "--description", "x", "--category", "Mercado");
    assert.equal(tx(r).account, "Inter");
  });

  test("ambiguity is reported", () => {
    const db = freshDb();
    ok(db, "account", "add", "--name", "Itaú Corrente");
    ok(db, "account", "add", "--name", "Itaú Poupança", "--type", "savings");
    assert.match(
      fails(db, "add", "--amount", "10", "--description", "x", "--account", "Itaú"),
      /Mais de uma conta/,
    );
  });

  test("invalid account type", () => {
    const db = freshDb();
    assert.match(fails(db, "account", "add", "--name", "X", "--type", "crypto"),
      /Tipo de conta inválido/);
  });
});

describe("queries and export", () => {
  function populated(): string {
    const db = freshDb();
    ok(db, "add", "--amount", "100", "--description", "Mercado do mês",
      "--category", "Mercado", "--tags", "essencial");
    ok(db, "add", "--amount", "50", "--description", "Uber aeroporto", "--category", "Uber/99");
    ok(db, "add", "--type", "income", "--amount", "5000", "--description", "Salário",
      "--category", "Salário");
    return db;
  }

  test("filtering by category includes its children", () => {
    assert.equal(ok(populated(), "ls", "--category", "Alimentação").total_count, 1);
  });

  test("filtering by type", () => {
    assert.equal(ok(populated(), "ls", "--type", "income").total_count, 1);
  });

  test("filtering by tag", () => {
    assert.equal(ok(populated(), "ls", "--tag", "essencial").total_count, 1);
  });

  test("totals cover the whole filter, not the page", () => {
    const r = ok(populated(), "ls", "--limit", "1");
    assert.equal((r.transactions as unknown[]).length, 1);
    assert.equal(r.total_count, 3);
    const totals = r.totals as { expense: { cents: number } };
    assert.equal(totals.expense.cents, 15000);
  });

  test("search is case-insensitive", () => {
    assert.equal(ok(populated(), "search", "MERCADO").count, 1);
  });

  test("CSV export opens in Excel in Portuguese", () => {
    const db = populated();
    const dest = mkdtempSync(join(tmpdir(), "tally-export-"));
    const r = ok(db, "export", "--period", "month", "--format", "csv", "--dest", dest);
    assert.equal(r.count, 3);
    const content = readFileSync(r.file as string, "utf8");
    assert.ok(content.startsWith("﻿"), "missing the BOM Excel expects");
    assert.match(content, /id;data;tipo/);
    assert.match(content, /100,00/);
  });

  test("JSON and MD export", () => {
    const db = populated();
    for (const format of ["json", "md"]) {
      const dest = mkdtempSync(join(tmpdir(), "tally-export-"));
      const r = ok(db, "export", "--period", "month", "--format", format, "--dest", dest);
      assert.ok(existsSync(r.file as string));
    }
  });

  test("invalid export format", () => {
    assert.match(fails(freshDb(), "export", "--format", "pdf"), /Formato inválido/);
  });
});

describe("schema", () => {
  test("init is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-schema-"));
    const path = join(dir, "x.db");
    assert.deepEqual(ok(path, "init").migrations_applied, [1]);
    const second = ok(path, "init");
    assert.deepEqual(second.migrations_applied, []);
    const seeded = second.seed as { categories: number };
    assert.equal(seeded.categories, 0);
  });

  test("any command auto-migrates a fresh database", () => {
    // The agent may call any command first, with no `init` beforehand.
    const dir = mkdtempSync(join(tmpdir(), "tally-schema-"));
    const r = ok(join(dir, "new.db"), "add", "--amount", "10", "--description", "first");
    assert.equal(tx(r).id, 1);
  });

  test("categories are seeded in Portuguese", () => {
    const r = ok(freshDb(), "category", "list");
    const categories = r.categories as Record<string, { children: string[] }>;
    assert.ok(categories["Alimentação"]);
    assert.ok(categories["Alimentação"].children.includes("Delivery"));
  });

  test("unknown subcommand", () => {
    assert.match(fails(freshDb(), "invest", "--amount", "10"), /desconhecido/);
  });
});
