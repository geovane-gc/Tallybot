/**
 * Tests for the finance CLI.
 *
 * They run with no credentials, no container and no network, which is what lets
 * the bot be validated before there is an OpenRouter key or a Telegram token.
 *
 * The focus is where a bug would corrupt months of data without showing up:
 * cent arithmetic, calendar boundaries, category hierarchy inside budgets,
 * idempotency of recurring entries — and, since two people share the database,
 * that neither of them can ever see or touch the other's money.
 *
 *     node --test tests/fin.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
  /** Everything the process wrote to stderr, kept so leak tests can inspect it. */
  _stderr: string;
  [k: string]: unknown;
}

/** The access code, handed to the subprocess the way production does. */
const CODE = "codigo-de-teste-longo-e-aleatorio-Xy7Q";
const USER_A = "111111111";
const USER_B = "222222222";

/**
 * Runs the CLI as a subprocess, with the environment fully under our control.
 *
 * Testing through the process rather than importing the functions is what keeps
 * the output contract, the exit codes and — now that identity comes from the
 * environment — the auth gate covered too.
 */
function spawn(
  db: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Response {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    TALLY_ACCESS_CODE: CODE,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const proc = spawnSync(process.execPath, [CLI, "--db", db, ...args], {
    encoding: "utf8",
    env: merged as NodeJS.ProcessEnv,
  });
  assert.ok(proc.stdout, `no output. stderr: ${proc.stderr}`);
  return {
    ...JSON.parse(proc.stdout),
    _exit: proc.status ?? -1,
    _stderr: proc.stderr ?? "",
  };
}

/**
 * The default caller for tests that are not about identity.
 *
 * There is no Hermes session here, so `--user` is the way in; it is filled in
 * with user A unless the test named someone itself.
 *
 * Worth being explicit about: because no `HERMES_SESSION_*` variable is set,
 * every test that goes through here runs on the **operator path** — the same one
 * the Makefile and cron use. That is deliberate (it is the only way to act as two
 * people from one process) but it means these tests say nothing about what a chat
 * turn can do. The "who is calling" suite covers that side on purpose, with the
 * session environment set.
 */
function run(db: string, ...args: string[]): Response {
  const scoped =
    args[0] !== "init" && args[0] !== "auth" && !args.includes("--user")
      ? [...args, "--user", USER_A]
      : args;
  return spawn(db, scoped);
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

function login(db: string, user: string, name?: string): Response {
  const args = ["auth", "login", "--user", user, "--code", CODE];
  if (name) args.push("--name", name);
  return ok(db, ...args);
}

/**
 * Mints an invite the way the operator does, and keeps the code.
 *
 * The mint response is the only place a code ever appears, which is exactly what
 * the leak test below pins down.
 */
function mintInvite(
  db: string,
  label = "Convidada",
  hours?: number,
): { code: string; id: number } {
  const args = ["auth", "invite", "--label", label];
  if (hours !== undefined) args.push("--hours", String(hours));
  const r = ok(db, ...args);
  return { code: r.code as string, id: (r.invite as { id: number }).id };
}

/** Types a code as `user`, without asserting anything about the outcome. */
function redeem(db: string, user: string, code: string): Response {
  return run(db, "auth", "login", "--user", user, "--code", code);
}

/**
 * Pushes an invite's expiry into the past.
 *
 * There is no way to travel forward from the CLI, and `--hours 0` is refused, so
 * the only honest way to test an expired invite is to age it in the file.
 */
function expireInvite(db: string, id: number): void {
  const conn = new DatabaseSync(db);
  try {
    conn
      .prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00-03:00", id);
  } finally {
    conn.close();
  }
}

const inviteList = (r: Response) =>
  r.invites as { id: number; status: string; label: string | null; redeemed_by: string | null }[];

/** An empty database with only the schema in it. */
function emptyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "tally-test-"));
  const path = join(dir, "tally.db");
  ok(path, "init");
  return path;
}

/** A fresh database with user A authenticated and seeded. */
function freshDb(): string {
  const path = emptyDb();
  login(path, USER_A, "Geovane");
  return path;
}

/** A fresh database with both people authenticated. */
function sharedDb(): string {
  const path = freshDb();
  login(path, USER_B, "Namorada");
  return path;
}

/**
 * A destination `export` will accept.
 *
 * `--dest` has to resolve inside the database's own directory, so a scratch
 * directory somewhere else under /tmp is refused on purpose.
 */
function exportDir(db: string, name = "exports"): string {
  return join(dirname(db), name);
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

  // Non-finite and absurd values. `1e307` parses as a number, then overflows to
  // Infinity once multiplied by 100, and used to reach SQLite — the user got
  // "NOT NULL constraint failed: transactions.amount_cents" in their chat.
  for (const bad of ["1e307", "1e400", 1e307, Infinity, -Infinity, NaN, "9e15"]) {
    test(`rejects the non-finite or absurd ${String(bad)}`, () => {
      assert.throws(() => parseAmount(bad), FinError);
    });
  }

  test("the ceiling is a real amount, not a magic number", () => {
    // R$ 100.000.000,00 goes through; one cent more does not.
    assert.equal(parseAmount("100000000"), 10_000_000_000);
    assert.throws(() => parseAmount("100000000,01"), FinError);
  });

  test("an absurd amount fails with Portuguese, not with SQL", () => {
    const db = freshDb();
    const message = fails(db, "add", "--amount", "1e307", "--description", "x");
    assert.match(message, /valor/i);
    assert.doesNotMatch(message, /constraint|NOT NULL|SQL/i);
    assert.equal(ok(db, "ls", "--period", "all").total_count, 0);
  });

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
    //
    // The day has to be *today*: with yesterday's day-of-month, `nextOccurrence`
    // schedules the charge for next month, `apply` generates nothing, and the test
    // ends up asserting that 0 equals 0 — which it did for a while.
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", today().slice(8));

    const first = ok(db, "recurring", "apply");
    assert.equal(first.count, 1, "the first run generated nothing to be idempotent about");
    assert.equal(first.silent, false);

    const second = ok(db, "recurring", "apply");
    assert.equal(second.count, 0);
    assert.equal(second.silent, true);
    assert.equal(ok(db, "ls", "--period", "all").total_count, 1);
  });

  test("apply is idempotent with --auto-debit too", () => {
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Netflix", "--amount", "44,90",
      "--category", "Streaming", "--day", today().slice(8), "--auto-debit");
    assert.equal(ok(db, "recurring", "apply").count, 1);
    assert.equal(ok(db, "recurring", "apply").count, 0);
    const rows = ok(db, "ls", "--period", "all").transactions as { status: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "paid");
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

describe("paid and pending", () => {
  /** A fixed cost due today, so `apply` has something to generate on any day. */
  function withRent(db: string, ...extra: string[]): void {
    ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", today().slice(8), ...extra);
  }

  const pendingOf = (r: Response) => r.pending as Record<string, never>[];

  interface AccountView {
    name: string;
    balance_cents: number;
    pending_cents: number;
    pending_fmt: string;
  }
  const account = (r: Response, name: string) =>
    (r.accounts as unknown as AccountView[]).find((c) => c.name === name)!;

  test("an occurrence is born pending, and paying it is the whole lifecycle", () => {
    const db = freshDb();
    withRent(db);

    const applied = ok(db, "recurring", "apply");
    assert.equal(applied.count, 1);
    assert.equal(applied.pending_count, 1);
    const id = (applied.generated as { id: number; status: string }[])[0].id;
    assert.equal((applied.generated as { status: string }[])[0].status, "pending");

    const listed = ok(db, "recurring", "pending");
    assert.equal(listed.count, 1);
    assert.equal(listed.total_fmt, "R$ 1.500,00");
    assert.equal(listed.silent, false);
    assert.equal(pendingOf(listed)[0].id, id);
    assert.equal(pendingOf(listed)[0].days_overdue, 0);

    const paid = ok(db, "recurring", "pay", String(id));
    assert.equal(paid.action, "paid");
    assert.equal(tx(paid).status, "paid");
    assert.ok(tx(paid).paid_at, "paid_at was not recorded");
    assert.equal(paid.amount_changed, false);

    assert.equal(ok(db, "recurring", "pending").count, 0);
    assert.equal(ok(db, "recurring", "pending").silent, true);

    // And undoing it puts it back.
    const undone = ok(db, "recurring", "unpay", String(id));
    assert.equal(tx(undone).status, "pending");
    assert.equal(tx(undone).paid_at, null);
    assert.equal(ok(db, "recurring", "pending").count, 1);
  });

  test("a pending bill stays out of the balance but counts against the budget", () => {
    // The decision the owner made: the balance is real cash, the budget is what he
    // has committed. So the rent shows up in one and not the other.
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Moradia", "--limit", "2000");
    ok(db, "add", "--type", "income", "--amount", "5000", "--description", "Salário",
      "--category", "Salário");
    withRent(db);
    ok(db, "recurring", "apply");

    const wallet = account(ok(db, "balance"), "Carteira");
    assert.equal(wallet.balance_cents, 500000, "the pending rent moved the balance");
    assert.equal(wallet.pending_cents, 150000);
    assert.equal(wallet.pending_fmt, "R$ 1.500,00");
    assert.equal(ok(db, "balance").total_pending_fmt, "R$ 1.500,00");

    const b = (ok(db, "budget", "status").budgets as Record<string, never>[])[0];
    assert.equal(b.spent_cents, 0, "spent must be paid money only");
    assert.equal(b.pending_cents, 150000);
    assert.equal(b.committed_cents, 150000);
    assert.equal(b.pct, 75);
    assert.equal(b.status, "ok");

    // Reports: the headline is paid, pending is its own block.
    const summary = ok(db, "summary", "--period", "month");
    assert.equal(summary.expenses_cents, 0);
    assert.equal(summary.pending_cents, 150000);
    assert.equal(summary.count, 2);

    // Paying it moves the money and leaves the budget where it was.
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;
    ok(db, "recurring", "pay", String(id));
    const after = account(ok(db, "balance"), "Carteira");
    assert.equal(after.balance_cents, 350000);
    assert.equal(after.pending_cents, 0);
    const b2 = (ok(db, "budget", "status").budgets as Record<string, never>[])[0];
    assert.equal(b2.spent_cents, 150000);
    assert.equal(b2.committed_cents, 150000);
    assert.equal(b2.pct, 75);
    assert.equal(ok(db, "summary", "--period", "month").expenses_cents, 150000);
  });

  test("a budget in trouble says how much of it is still to pay", () => {
    const db = freshDb();
    ok(db, "budget", "set", "--category", "Moradia", "--limit", "1600");
    ok(db, "add", "--amount", "100", "--description", "Luz", "--category", "Luz");
    withRent(db);
    ok(db, "recurring", "apply");

    const alert = (ok(db, "alerts").alerts as { message: string; level: string }[])[0];
    assert.equal(alert.level, "over");
    assert.match(alert.message, /R\$ 1\.600,00/);
    assert.match(alert.message, /R\$ 1\.500,00 disso ainda a pagar/);

    const text = ok(db, "report", "--period", "month").text as string;
    assert.match(text, /\*A pagar:\* R\$ 1\.500,00/);
    assert.match(text, /⏳ Aluguel/);
    assert.match(text, /ainda a pagar/);
    // Gastos is paid money only.
    assert.match(text, /💸 Gastos: \*R\$ 100,00\*/);
  });

  test("--auto-debit posts the occurrence already paid", () => {
    const db = freshDb();
    withRent(db, "--auto-debit");
    const applied = ok(db, "recurring", "apply");
    assert.equal((applied.generated as { status: string }[])[0].status, "paid");
    assert.equal(applied.pending_count, 0);
    assert.equal(ok(db, "recurring", "pending").count, 0);
    // It is real spending straight away, and it did move the balance.
    assert.equal(ok(db, "summary", "--period", "month").expenses_cents, 150000);
    const wallet = account(ok(db, "balance"), "Carteira");
    assert.equal(wallet.balance_cents, -150000);
    assert.equal(wallet.pending_cents, 0);

    const listed = (ok(db, "recurring", "list").recurring as { auto_debit: number }[])[0];
    assert.equal(listed.auto_debit, 1);
  });

  test("an income occurrence is never pending", () => {
    // Nobody has to pay their own salary in, so there is nothing to settle.
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Salário", "--amount", "7000",
      "--type", "income", "--category", "Salário", "--day", today().slice(8));
    const applied = ok(db, "recurring", "apply");
    assert.equal((applied.generated as { status: string }[])[0].status, "paid");
    assert.equal(ok(db, "summary", "--period", "month").income_cents, 700000);
  });

  test("--amount on payment is respected, and the difference is reported", () => {
    // A light bill is never the same twice.
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Luz", "--amount", "180",
      "--category", "Luz", "--day", today().slice(8));
    ok(db, "recurring", "apply");
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;

    const paid = ok(db, "recurring", "pay", String(id), "--amount", "212,40");
    assert.equal(tx(paid).amount_cents, 21240);
    assert.equal(paid.amount_changed, true);
    assert.equal(paid.expected_fmt, "R$ 180,00");
    assert.equal(paid.difference_fmt, "R$ 32,40");
    assert.match(paid.message as string, /acima do previsto/);
    assert.equal(ok(db, "summary", "--period", "month").expenses_cents, 21240);
  });

  test("paying below the estimate reads as below", () => {
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Água", "--amount", "120",
      "--category", "Água", "--day", today().slice(8));
    ok(db, "recurring", "apply");
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;
    const paid = ok(db, "recurring", "pay", String(id), "--amount", "98");
    assert.match(paid.message as string, /abaixo do previsto/);
    assert.equal(paid.difference_fmt, "-R$ 22,00");
  });

  test("--date records when it was paid and leaves the due date alone", () => {
    // A bill paid late still belongs to the month it was due in; moving `date`
    // would rewrite that month's report.
    const db = freshDb();
    withRent(db);
    ok(db, "recurring", "apply");
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;
    const due = (ok(db, "recurring", "pending").pending as { date: string }[])[0].date;

    const paid = ok(db, "recurring", "pay", String(id), "--date", "hoje");
    assert.equal(tx(paid).date, due);
    assert.equal(tx(paid).paid_at, today());
  });

  test("paying twice, and unpaying what was never pending", () => {
    const db = freshDb();
    withRent(db);
    ok(db, "recurring", "apply");
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;

    ok(db, "recurring", "pay", String(id));
    assert.match(fails(db, "recurring", "pay", String(id)), /já está pago/);
    ok(db, "recurring", "unpay", String(id));
    assert.match(fails(db, "recurring", "unpay", String(id)), /já está marcado/);
  });

  test("a one-off expense cannot be turned into a bill to pay", () => {
    // It was paid by definition — the money is gone. Letting `unpay` reach it
    // would take cash out of the balance that is genuinely spent.
    const db = freshDb();
    const created = ok(db, "add", "--amount", "27", "--description", "Uber");
    assert.match(fails(db, "recurring", "unpay", String(created.id)), /não é uma conta fixa/);
    assert.equal(
      (ok(db, "ls", "--period", "all").transactions as { status: string }[])[0].status,
      "paid",
    );
  });

  test("pay and unpay need an id", () => {
    const db = freshDb();
    assert.match(fails(db, "recurring", "pay"), /id do lançamento/);
    assert.match(fails(db, "recurring", "unpay", "abc"), /id do lançamento/);
    assert.match(fails(db, "recurring", "pay", "999"), /#999/);
  });

  test("recurring due reads the schedule, before any occurrence exists", () => {
    // The day before a bill falls due there is no transaction yet — `apply` only
    // creates it on the day. A reminder that waited for the row would always be a
    // day late, so `due` reads `recurring.next_date` instead.
    const db = freshDb();
    const tomorrow = addDays(today(), 1);
    const created = ok(db, "recurring", "add", "--description", "Internet",
      "--amount", "119,90", "--category", "Internet", "--day", tomorrow.slice(8));
    // Asserted rather than assumed: `--day <tomorrow's day>` resolves to tomorrow
    // on every day of every month, including the last one (where it rolls into the
    // next month and still lands on tomorrow).
    assert.equal(created.next_date, tomorrow);

    // Nothing has been generated: the ledger is empty.
    assert.equal(ok(db, "ls", "--period", "all").total_count, 0);
    assert.equal(ok(db, "recurring", "pending").count, 0);

    const due = ok(db, "recurring", "due");
    assert.equal(due.count, 1);
    assert.equal(due.silent, false);
    assert.equal(due.total_fmt, "R$ 119,90");
    const item = (due.due as Record<string, never>[])[0];
    assert.equal(item.description, "Internet");
    assert.equal(item.due_date, tomorrow);
    assert.equal(item.days_until, 1);
    assert.equal(item.auto_debit, false);
    assert.equal(item.amount_fmt, "R$ 119,90");
  });

  test("recurring due is silent when nothing is close, and --in widens the window", () => {
    const db = freshDb();
    const target = addDays(today(), 20);
    const created = ok(db, "recurring", "add", "--description", "IPTU", "--amount", "300",
      "--category", "IPTU", "--day", target.slice(8));
    assert.equal(created.next_date, target);

    const soon = ok(db, "recurring", "due");
    assert.equal(soon.count, 0);
    assert.equal(soon.silent, true);

    const wide = ok(db, "recurring", "due", "--in", "30");
    assert.equal(wide.count, 1);
    assert.equal((wide.due as { days_until: number }[])[0].days_until, 20);
  });

  test("recurring due reports auto-debit, since nobody has to act on those", () => {
    const db = freshDb();
    withRent(db, "--auto-debit");
    const item = (ok(db, "recurring", "due", "--in", "0").due as { auto_debit: boolean }[])[0];
    assert.equal(item.auto_debit, true);
  });

  test("an invalid --in is refused", () => {
    assert.match(fails(freshDb(), "recurring", "due", "--in", "9999"), /--in/);
  });

  test("ls --status filters, and every row carries its status", () => {
    const db = freshDb();
    ok(db, "add", "--amount", "27", "--description", "Uber");
    withRent(db);
    ok(db, "recurring", "apply");

    const all = ok(db, "ls", "--period", "all");
    assert.equal(all.total_count, 2, "the default has to show both");
    assert.equal(all.pending_fmt, "R$ 1.500,00");
    const statuses = (all.transactions as { status: string }[]).map((t) => t.status).sort();
    assert.deepEqual(statuses, ["paid", "pending"]);

    assert.equal(ok(db, "ls", "--period", "all", "--status", "pending").total_count, 1);
    assert.equal(ok(db, "ls", "--period", "all", "--status", "paid").total_count, 1);
    assert.equal(ok(db, "ls", "--period", "all", "--status", "all").total_count, 2);
    assert.match(fails(db, "ls", "--status", "quitado"), /Status inválido/);
  });

  test("an overdue bill says how many days late it is", () => {
    const db = freshDb();
    withRent(db);
    ok(db, "recurring", "apply");
    const id = (ok(db, "recurring", "pending").pending as { id: number }[])[0].id;
    // Backdated to yesterday, as if it had fallen due then and gone unpaid.
    ok(db, "edit", String(id), "--date", "ontem");

    const bill = (ok(db, "recurring", "pending").pending as
      { days_overdue: number; overdue: boolean; status: string }[])[0];
    assert.equal(bill.days_overdue, 1);
    assert.equal(bill.overdue, true);
    // Editing a field must not quietly settle it.
    assert.equal(bill.status, "pending");

    assert.match(ok(db, "report", "--period", "30d").text as string, /1 dia em atraso/);
  });

  test("neither payment nor pending crosses between the two people", () => {
    const db = sharedDb();
    withRent(db);
    ok(db, "recurring", "add", "--description", "Academia", "--amount", "120",
      "--category", "Academia", "--day", today().slice(8), "--user", USER_B);
    ok(db, "recurring", "apply");
    ok(db, "recurring", "apply", "--user", USER_B);

    const mine = ok(db, "recurring", "pending");
    const hers = ok(db, "recurring", "pending", "--user", USER_B);
    assert.equal(mine.count, 1);
    assert.equal(hers.count, 1);
    assert.ok(!JSON.stringify(mine).includes("Academia"));

    const hersId = (hers.pending as { id: number }[])[0].id;
    // The same non-revealing message an id that never existed gets.
    assert.match(fails(db, "recurring", "pay", String(hersId)), new RegExp(`#${hersId}`));
    assert.match(fails(db, "recurring", "unpay", String(hersId)), new RegExp(`#${hersId}`));
    // Untouched, and still hers to pay.
    assert.equal(ok(db, "recurring", "pending", "--user", USER_B).count, 1);
    ok(db, "recurring", "pay", String(hersId), "--user", USER_B);
    assert.equal(ok(db, "recurring", "pending", "--user", USER_B).count, 0);
    // Her payment did not settle mine.
    assert.equal(ok(db, "recurring", "pending").count, 1);
  });

  test("due only reads your own schedule", () => {
    const db = sharedDb();
    withRent(db, "--auto-debit");
    assert.equal(ok(db, "recurring", "due", "--in", "0").count, 1);
    assert.equal(ok(db, "recurring", "due", "--in", "0", "--user", USER_B).count, 0);
    assert.equal(ok(db, "recurring", "due", "--in", "0", "--user", USER_B).silent, true);
  });
});

describe("the legacy ledger", () => {
  /**
   * A database in the state migration 2 leaves behind for a pre-existing ledger.
   *
   * Reproducing it through the CLI is not possible — the placeholder can never log
   * in, which is the whole problem — so the row is written directly here. This is
   * the only test that touches the file behind the CLI's back, and it does it to
   * set up a state the CLI is supposed to be able to clean up.
   */
  function withLegacyRows(): string {
    const path = emptyDb();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "INSERT INTO users (telegram_user_id, display_name, authenticated_at, auth_epoch," +
        " active, created_at) VALUES ('legacy', 'Legacy', NULL, 0, 1, '2025-01-01T00:00:00-03:00')",
    );
    const uid = Number(
      (db.prepare("SELECT id FROM users WHERE telegram_user_id = 'legacy'").get() as
        { id: number }).id,
    );
    db.exec(
      `INSERT INTO accounts (user_id, name, type, created_at)
         VALUES (${uid}, 'Carteira', 'cash', '2025-01-01T00:00:00-03:00')`,
    );
    db.exec(
      `INSERT INTO categories (user_id, name, parent_id, type)
         VALUES (${uid}, 'Alimentação', NULL, 'expense')`,
    );
    db.exec(
      `INSERT INTO transactions (user_id, type, amount_cents, description, date,
                                 account_id, created_at, updated_at)
         VALUES (${uid}, 'expense', 4200, 'Gasto antigo', '2025-06-15',
                 (SELECT id FROM accounts WHERE user_id = ${uid}),
                 '2025-06-15T10:00:00-03:00', '2025-06-15T10:00:00-03:00')`,
    );
    db.close();
    return path;
  }

  test("adopt-legacy hands the old rows to a real person", () => {
    const db = withLegacyRows();
    // Before: the history belongs to nobody reachable.
    assert.equal(run(db, "ls", "--period", "all", "--user", USER_A).auth_required, true);

    const r = ok(db, "auth", "adopt-legacy", "--user", USER_A);
    assert.equal(r.action, "legacy_adopted");
    assert.equal(r.created_user, true);
    assert.ok(Number(r.rows) >= 3);

    // The placeholder is gone.
    const users = ok(db, "auth", "users").users as { telegram_user_id: string }[];
    assert.deepEqual(users.map((u) => u.telegram_user_id), [USER_A]);

    // One login, and the history is there.
    login(db, USER_A, "Geovane");
    const listed = ok(db, "ls", "--period", "all");
    assert.equal(listed.total_count, 1);
    assert.match(JSON.stringify(listed), /Gasto antigo/);
    assert.equal(ok(db, "summary", "--period", "2025-06").expenses_cents, 4200);
  });

  test("adopt-legacy merges into somebody who has already logged in", () => {
    const db = withLegacyRows();
    login(db, USER_A, "Geovane");
    // Seeded, but nothing of their own recorded yet — the normal case.
    assert.equal(ok(db, "ls", "--period", "all").total_count, 0);

    const r = ok(db, "auth", "adopt-legacy", "--user", USER_A);
    assert.equal(r.created_user, false);
    assert.ok(Number(r.discarded) > 0, "the seeded rows should have been cleared");
    assert.equal(ok(db, "ls", "--period", "all").total_count, 1);
    assert.equal(ok(db, "auth", "users").count, 1);
    // Still usable: a login fills back in whatever the old ledger lacked.
    login(db, USER_A);
    ok(db, "add", "--amount", "10", "--description", "novo", "--category", "Mercado");
    assert.equal(ok(db, "ls", "--period", "all").total_count, 2);
  });

  test("adopt-legacy refuses to merge two real histories", () => {
    const db = withLegacyRows();
    login(db, USER_A, "Geovane");
    ok(db, "add", "--amount", "50", "--description", "meu próprio", "--category", "Mercado");
    assert.match(
      fails(db, "auth", "adopt-legacy", "--user", USER_A),
      /já tem lançamentos próprios/,
    );
    // Nothing moved, nothing lost.
    assert.equal(ok(db, "ls", "--period", "all").total_count, 1);
    assert.equal(ok(db, "auth", "users").count, 2);
  });

  test("adopt-legacy on a database with no legacy user", () => {
    assert.match(
      fails(freshDb(), "auth", "adopt-legacy", "--user", USER_A),
      /Não há histórico antigo/,
    );
  });

  test("adopt-legacy will not adopt into the placeholder itself", () => {
    assert.match(
      fails(withLegacyRows(), "auth", "adopt-legacy", "--user", "legacy"),
      /legacy/,
    );
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

  test("rm and default require --name instead of quietly doing nothing", () => {
    // With no `--name` the name resolved to null, a `!` waved it through, and
    // `UPDATE ... WHERE id = NULL` matched nothing — while the command answered
    // `ok: true`. `default` was worse: it threw a raw TypeError about reading
    // properties of undefined.
    const db = freshDb();
    ok(db, "account", "add", "--name", "Inter");
    assert.match(fails(db, "account", "rm"), /--name/);
    assert.match(fails(db, "account", "default"), /--name/);
    // Nothing happened: both accounts are still there and the default is unchanged.
    assert.equal((ok(db, "balance").accounts as unknown[]).length, 2);
    assert.equal(tx(ok(db, "add", "--amount", "10", "--description", "x")).account,
      "Carteira");
  });

  test("category rm requires --name too", () => {
    const db = freshDb();
    const before = ok(db, "category", "list").count;
    assert.match(fails(db, "category", "rm"), /--name/);
    assert.equal(ok(db, "category", "list").count, before);
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
    const dest = exportDir(db, "csv");
    const r = ok(db, "export", "--period", "month", "--format", "csv", "--dest", dest);
    assert.equal(r.count, 3);
    const content = readFileSync(r.file as string, "utf8");
    assert.ok(content.startsWith("﻿"), "missing the BOM Excel expects");
    assert.match(content, /id;data;tipo/);
    assert.match(content, /100,00/);
    // The spreadsheet has to distinguish a bill from a payment, or the month adds
    // up to something the user never spent.
    assert.match(content, /;situacao;/);
    assert.match(content, /;pago;/);
  });

  test("an unpaid bill exports as 'a pagar'", () => {
    const db = freshDb();
    ok(db, "recurring", "add", "--description", "Aluguel", "--amount", "1500",
      "--category", "Aluguel", "--day", today().slice(8));
    ok(db, "recurring", "apply");
    const r = ok(db, "export", "--period", "month", "--dest", exportDir(db, "pending"));
    assert.match(readFileSync(r.file as string, "utf8"), /;a pagar;/);
  });

  test("JSON and MD export", () => {
    const db = populated();
    for (const format of ["json", "md"]) {
      const dest = exportDir(db, format);
      const r = ok(db, "export", "--period", "month", "--format", format, "--dest", dest);
      assert.ok(existsSync(r.file as string));
    }
  });

  test("invalid export format", () => {
    assert.match(fails(freshDb(), "export", "--format", "pdf"), /Formato inválido/);
  });

  test("export with no --dest writes next to the database", () => {
    const db = populated();
    const r = ok(db, "export", "--period", "month");
    assert.equal(dirname(r.file as string), exportDir(db));
  });

  test("--dest outside the data directory is refused", () => {
    // It used to be used verbatim: `--dest ../../pwned` really did write a copy
    // of somebody's whole month wherever the caller pointed it.
    const db = populated();
    const outside = mkdtempSync(join(tmpdir(), "tally-elsewhere-"));
    for (const dest of [outside, join(dirname(db), "..", "escape"), "/tmp"]) {
      assert.match(
        fails(db, "export", "--period", "month", "--dest", dest),
        /pasta de dados/,
        `--dest ${dest} was accepted`,
      );
    }
    assert.equal(existsSync(join(outside, "exports")), false);
  });

  test("a subdirectory of the data directory is fine", () => {
    const db = populated();
    const r = ok(db, "export", "--period", "month", "--dest", exportDir(db, "sub/deeper"));
    assert.ok(existsSync(r.file as string));
  });
});

describe("schema", () => {
  test("init is idempotent and only touches the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-schema-"));
    const path = join(dir, "x.db");
    const first = ok(path, "init");
    assert.deepEqual(first.migrations_applied, [1, 2, 3, 4]);
    assert.equal(first.schema_version, 4);
    const second = ok(path, "init");
    assert.deepEqual(second.migrations_applied, []);
    // Seeding moved to registration: `init` must not create a user, a category
    // or an account of its own.
    assert.equal(ok(path, "auth", "users").count, 0);
  });

  test("auth login auto-migrates a fresh database", () => {
    // The first thing that ever happens may be a login, with no `init` first.
    const dir = mkdtempSync(join(tmpdir(), "tally-schema-"));
    const path = join(dir, "new.db");
    const r = login(path, USER_A);
    assert.equal(r.new_user, true);
    const r2 = ok(path, "add", "--amount", "10", "--description", "first");
    assert.equal(tx(r2).id, 1);
  });

  test("categories are seeded in Portuguese, per user", () => {
    const r = ok(freshDb(), "category", "list");
    const categories = r.categories as Record<string, { children: string[] }>;
    assert.ok(categories["Alimentação"]);
    assert.ok(categories["Alimentação"].children.includes("Delivery"));
  });

  test("registering seeds that user's own taxonomy and wallet", () => {
    const db = freshDb();
    const before = ok(db, "category", "list").count as number;
    const r = login(db, USER_B, "Namorada");
    const seeded = r.seed as { categories: number; accounts: number };
    assert.equal(seeded.categories, 17);
    assert.equal(seeded.accounts, 1);
    // A separate set of rows, not a shared one.
    assert.equal(ok(db, "category", "list", "--user", USER_B).count, before);
    const wallet = (ok(db, "balance", "--user", USER_B).accounts as { name: string }[])[0];
    assert.equal(wallet.name, "Carteira");
  });

  test("logging in again does not duplicate the seed", () => {
    const db = freshDb();
    const again = login(db, USER_A);
    assert.equal(again.new_user, false);
    assert.deepEqual(again.seed, { categories: 0, subcategories: 0, accounts: 0 });
  });

  test("unknown subcommand", () => {
    assert.match(fails(freshDb(), "invest", "--amount", "10"), /desconhecido/);
  });
});

describe("authentication", () => {
  test("an unregistered user is refused, with auth_required", () => {
    const db = emptyDb();
    const r = run(db, "ls", "--user", "999999999");
    assert.equal(r.ok, false);
    assert.equal(r.auth_required, true);
    assert.match(r.error!, /código de acesso/i);
  });

  test("every data subcommand is gated, not just the writes", () => {
    const db = emptyDb();
    const commands = [
      ["add", "--amount", "10", "--description", "x"],
      ["edit", "1", "--amount", "10"],
      ["rm", "1"],
      ["ls"],
      ["search", "x"],
      ["balance"],
      ["summary"],
      ["report"],
      ["budget", "status"],
      ["alerts"],
      ["account", "list"],
      ["category", "list"],
      ["recurring", "list"],
      ["recurring", "apply"],
      ["goal", "list"],
      ["export"],
    ];
    for (const args of commands) {
      const r = run(db, ...args, "--user", "999999999");
      assert.equal(r.ok, false, `${args[0]} let an unauthenticated caller through`);
      assert.equal(r.auth_required, true, `${args[0]} did not ask for the code`);
    }
  });

  test("a revoked session looks exactly like an unknown one", () => {
    // Same shape for both, so the agent has a single case to handle and nobody
    // can probe which ids are registered.
    const db = freshDb();
    ok(db, "auth", "logout-all");
    const revoked = run(db, "balance", "--user", USER_A);
    const unknown = run(db, "balance", "--user", "888888888");
    assert.equal(revoked.error, unknown.error);
    assert.equal(revoked.auth_required, true);
    assert.equal(unknown.auth_required, true);
  });

  test("the wrong code is refused, the right one authenticates", () => {
    const db = emptyDb();
    const bad = run(db, "auth", "login", "--user", USER_A, "--code", "chute");
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /Código incorreto/);
    assert.equal(run(db, "ls", "--user", USER_A).auth_required, true);

    login(db, USER_A);
    assert.equal(ok(db, "ls", "--user", USER_A).ok, true);
  });

  test("a wrong code says the same thing whether or not the id is known", () => {
    // Otherwise the message itself would tell an outsider which ids exist.
    const db = freshDb();
    const known = run(db, "auth", "login", "--user", USER_A, "--code", "chute");
    const unknown = run(db, "auth", "login", "--user", "777777777", "--code", "chute");
    assert.equal(known.error, unknown.error);
  });

  test("the access code never appears in any output", () => {
    // Both streams. stdout is the contract, but a stack trace or a warning goes
    // to stderr, and the gateway captures both — a code echoed there is just as
    // leaked.
    //
    // Known limitation, not something this test can cover: `--code <value>` is an
    // argv entry, so it is visible to anyone who can run `ps` on the host for as
    // long as the process lives, and it may land in a shell history. Fixing that
    // means reading the code from stdin instead of an option, which the agent's
    // terminal tool cannot currently do.
    const db = emptyDb();
    const outputs = [
      run(db, "auth", "login", "--user", USER_A, "--code", "errado"),
      run(db, "auth", "login", "--user", USER_A, "--code", CODE),
      run(db, "auth", "status", "--user", USER_A),
      run(db, "auth", "users"),
      run(db, "auth", "status"),
      run(db, "auth", "logout-all"),
      run(db, "ls", "--user", USER_A),
      run(db, "balance", "--user", USER_A),
      // The failure paths too: an unexpected error is where a value tends to
      // escape into a message.
      run(db, "auth", "login", "--user", "nao-numerico", "--code", CODE),
      run(db, "auth", "renew", "--user", USER_A, "--code", CODE),
    ];
    for (const r of outputs) {
      const text = `${JSON.stringify(r)}\n${r._stderr}`;
      assert.ok(!text.includes(CODE), `the code leaked into: ${text.slice(0, 200)}`);
      // Nor its hash, nor the variable's name.
      assert.ok(!text.includes("TALLY_ACCESS_CODE"), "the variable name leaked");
    }
  });

  test("a missing code is asked for, not guessed", () => {
    const db = emptyDb();
    assert.match(fails(db, "auth", "login", "--user", USER_A), /código/i);
  });

  test("five wrong codes lock the account, and the right code no longer works", () => {
    const db = emptyDb();
    for (let i = 0; i < 4; i++) {
      assert.match(
        fails(db, "auth", "login", "--user", USER_A, "--code", `chute-${i}`),
        /Código incorreto/,
      );
    }
    // The fifth is what trips it.
    assert.match(
      fails(db, "auth", "login", "--user", USER_A, "--code", "chute-4"),
      /Bloqueei as tentativas/,
    );
    // And the correct code is refused too, until the lock is lifted.
    assert.match(
      fails(db, "auth", "login", "--user", USER_A, "--code", CODE),
      /Bloqueei as tentativas/,
    );
    assert.equal(ok(db, "auth", "status", "--user", USER_A).locked, true);
  });

  test("a wrong code creates no user row for the id that got it wrong", () => {
    // The counter lives in app_state now. It used to be a column on `users`,
    // which meant every guessed id planted a permanent row — free pollution of
    // the list cron fans out over.
    const db = emptyDb();
    for (const id of ["987654321", "987654322", "987654323"]) {
      fails(db, "auth", "login", "--user", id, "--code", "chute");
    }
    assert.equal(ok(db, "auth", "users").count, 0);
    assert.equal(ok(db, "auth", "status", "--user", "987654321").registered, false);
  });

  test("a new --user does not buy five fresh attempts", () => {
    // Bypass (a) of the old lockout: the per-id counter is keyed by something the
    // caller chooses, so cycling ids meant unlimited guesses. The global counter
    // is what closes it — 20 wrong codes and nobody gets to try, whatever id they
    // claim.
    const db = emptyDb();
    let locked = false;
    for (let i = 0; i < 20; i++) {
      // A different id every time: each one is on its first attempt.
      const message = fails(db, "auth", "login", "--user", `9000000${10 + i}`, "--code", "x");
      if (/Bloqueei as tentativas/.test(message)) locked = true;
    }
    assert.equal(locked, true, "20 wrong codes across 20 ids did not lock anything");
    // A brand-new id, first attempt, correct code: still refused.
    assert.match(
      fails(db, "auth", "login", "--user", "555000111", "--code", CODE),
      /Bloqueei as tentativas/,
    );
  });

  test("logout-all does not lift a lockout", () => {
    // Bypass (b): `logout-all` used to zero every failure counter, and it needs
    // no authentication — so the lockout was undone by the one command anybody
    // could run. Lifting a lock is `auth unlock` now, and nothing else.
    const db = emptyDb();
    for (let i = 0; i < 5; i++) {
      fails(db, "auth", "login", "--user", USER_A, "--code", "chute");
    }
    ok(db, "auth", "logout-all");
    assert.match(
      fails(db, "auth", "login", "--user", USER_A, "--code", CODE),
      /Bloqueei as tentativas/,
    );
    assert.equal(ok(db, "auth", "status", "--user", USER_A).locked, true);
  });

  test("auth unlock is what lifts a lockout", () => {
    const db = emptyDb();
    for (let i = 0; i < 5; i++) {
      fails(db, "auth", "login", "--user", USER_A, "--code", "chute");
    }
    const r = ok(db, "auth", "unlock", "--user", USER_A);
    assert.equal(r.attempts_cleared, 5);
    login(db, USER_A);
    assert.equal(ok(db, "auth", "status", "--user", USER_A).current, true);
  });

  test("auth unlock needs to be told who", () => {
    assert.match(fails(emptyDb(), "auth", "unlock"), /--user/);
  });

  test("a correct login resets the failure count", () => {
    const db = emptyDb();
    fails(db, "auth", "login", "--user", USER_A, "--code", "chute");
    fails(db, "auth", "login", "--user", USER_A, "--code", "chute");
    login(db, USER_A);
    // Four more wrong ones must not trip the lock, since the counter went back
    // to zero.
    for (let i = 0; i < 4; i++) {
      assert.match(
        fails(db, "auth", "login", "--user", USER_A, "--code", "chute"),
        /Código incorreto/,
      );
    }
  });

  test("logout-all invalidates every session and keeps every transaction", () => {
    const db = sharedDb();
    ok(db, "add", "--amount", "100", "--description", "Mercado", "--category", "Mercado");
    ok(db, "add", "--amount", "50", "--description", "Bar", "--category", "Bar",
      "--user", USER_B);

    const out = ok(db, "auth", "logout-all");
    assert.equal(out.sessions_invalidated, 2);
    assert.equal(out.auth_epoch, 1);

    for (const user of [USER_A, USER_B]) {
      assert.equal(run(db, "ls", "--user", user).auth_required, true);
    }

    // The data was never touched: it is all there after re-authenticating.
    login(db, USER_A);
    login(db, USER_B);
    assert.equal(ok(db, "ls", "--period", "all").total_count, 1);
    assert.equal(ok(db, "summary", "--period", "month").expenses_cents, 10000);
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_B).total_count, 1);
    assert.equal(
      ok(db, "summary", "--period", "month", "--user", USER_B).expenses_cents,
      5000,
    );
  });

  test("logout-all counts only the sessions that were live", () => {
    const db = freshDb();
    ok(db, "auth", "logout-all");
    assert.equal(ok(db, "auth", "logout-all").sessions_invalidated, 0);
  });

  test("auth status, for one person and for everyone", () => {
    const db = sharedDb();
    const one = ok(db, "auth", "status", "--user", USER_A);
    assert.equal(one.registered, true);
    assert.equal(one.current, true);

    const stranger = ok(db, "auth", "status", "--user", "555555555");
    assert.equal(stranger.registered, false);
    assert.equal(stranger.current, false);

    const all = ok(db, "auth", "status");
    assert.equal(all.count, 2);
    assert.equal(all.current_count, 2);
  });

  test("auth users is clean machine-readable JSON for the cron fan-out", () => {
    const db = sharedDb();
    const r = ok(db, "auth", "users");
    assert.equal(r.count, 2);
    const users = r.users as Record<string, unknown>[];
    assert.deepEqual(
      users.map((u) => u.telegram_user_id),
      [USER_A, USER_B],
    );
    assert.deepEqual(
      users.map((u) => u.display_name),
      ["Geovane", "Namorada"],
    );
    for (const u of users) {
      assert.equal(u.authenticated, true);
      assert.equal(u.current, true);
      assert.equal(u.active, true);
      // What `--deliver telegram:<chat_id>` will consume. In a private chat it
      // is the person's own id.
      assert.equal(u.telegram_chat_id, u.telegram_user_id);
      assert.ok(!("failed_attempts" in u));
    }
  });

  test("unknown auth action", () => {
    assert.match(fails(freshDb(), "auth", "renew"), /desconhecida/);
  });
});

describe("invites", () => {
  test("an invite registers one person and is dead afterwards", () => {
    const db = emptyDb();
    const { code, id } = mintInvite(db, "Namorada");

    const first = redeem(db, USER_A, code);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.via, "invite");
    assert.equal(first.invite_id, id);
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_A).ok, true);

    // Single use: the same code from anybody else, including the same person, is
    // just a wrong code now.
    assert.equal(redeem(db, USER_B, code).error, "Código incorreto.");
    assert.equal(ok(db, "auth", "users").count, 1);

    const listed = inviteList(ok(db, "auth", "invites"));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "redeemed");
    assert.equal(listed[0].redeemed_by, USER_A);
    assert.equal(listed[0].label, "Namorada");
  });

  test("a code typed by ear — lower case, spaces, no dashes — still works", () => {
    // It is dictated in person, so it comes back typed however the person types.
    // Refusing a code they heard correctly is the failure mode to avoid.
    for (const shape of [
      (c: string) => c.toLowerCase(),
      (c: string) => c.replaceAll("-", ""),
      (c: string) => c.toLowerCase().replaceAll("-", " "),
      (c: string) => `  ${c.toLowerCase().replaceAll("-", "  ")} `,
    ]) {
      const db = emptyDb();
      const { code } = mintInvite(db);
      const r = redeem(db, USER_A, shape(code));
      assert.equal(r.ok, true, `${shape(code)} was refused: ${r.error}`);
      assert.equal(r.via, "invite");
    }
  });

  test("the code has no character anyone can mishear", () => {
    // 0/O and 1/I/L are what a dictated code gets wrong, and a wrong code spends
    // one of the five attempts before the lockout.
    const db = emptyDb();
    for (let i = 0; i < 15; i++) {
      const { code } = mintInvite(db, `Convite ${i}`);
      assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      assert.ok(!/[01OIL]/.test(code), `ambiguous character in ${code}`);
    }
  });

  test("an expired invite is refused", () => {
    const db = emptyDb();
    const { code, id } = mintInvite(db, "Vencida");
    expireInvite(db, id);
    assert.equal(redeem(db, USER_A, code).error, "Código incorreto.");
    assert.equal(inviteList(ok(db, "auth", "invites"))[0].status, "expired");
    assert.equal(ok(db, "auth", "users").count, 0);
  });

  test("a revoked invite is refused", () => {
    const db = emptyDb();
    const { code, id } = mintInvite(db, "Cancelada");
    const r = ok(db, "auth", "revoke-invite", String(id));
    assert.equal(r.already_revoked, false);
    assert.equal(redeem(db, USER_A, code).error, "Código incorreto.");
    assert.equal(inviteList(ok(db, "auth", "invites"))[0].status, "revoked");

    // Revoking it again is not an error, and does not claim to have done anything.
    assert.equal(ok(db, "auth", "revoke-invite", String(id)).already_revoked, true);
  });

  test("expired, revoked, spent and never-issued all say the same thing", () => {
    // Otherwise the message tells an outsider which codes once existed.
    const db = emptyDb();

    const spent = mintInvite(db, "Usada");
    assert.equal(redeem(db, USER_A, spent.code).ok, true);
    const expired = mintInvite(db, "Vencida");
    expireInvite(db, expired.id);
    const revoked = mintInvite(db, "Cancelada");
    ok(db, "auth", "revoke-invite", String(revoked.id));

    const codes = [spent.code, expired.code, revoked.code, "7K2M-QX9P-4TVB"];
    const errors = codes.map((code, i) => redeem(db, `33300000${i}`, code).error);
    for (const error of errors) {
      assert.equal(error, "Código incorreto.", `distinguishable answer: ${error}`);
    }
    // And the same thing the shared-code path says for a plain wrong guess.
    assert.equal(errors[0], redeem(db, "334000000", "chute").error);
  });

  test("a wrong invite code feeds the existing lockout, not a second one", () => {
    const db = emptyDb();
    const { code, id } = mintInvite(db, "Namorada");

    for (let i = 0; i < 4; i++) {
      assert.match(redeem(db, USER_A, `AAAA-BBBB-CCC${i}`).error!, /Código incorreto/);
    }
    assert.match(redeem(db, USER_A, "AAAA-BBBB-CCCH").error!, /Bloqueei as tentativas/);
    // Even the real code is refused while the lock stands: one lockout, both ways in.
    assert.match(redeem(db, USER_A, code).error!, /Bloqueei as tentativas/);
    assert.equal(ok(db, "auth", "status", "--user", USER_A).locked, true);
    // And none of that consumed the invite.
    assert.equal(inviteList(ok(db, "auth", "invites"))[0].status, "pending");

    ok(db, "auth", "unlock", "--user", USER_A);
    const r = redeem(db, USER_A, code);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.invite_id, id);
  });

  test("two simultaneous redemptions of one invite yield exactly one success", () => {
    // The reason `redeemInvite` is one transaction with a conditional UPDATE. Both
    // processes are started before either can finish, from one shell.
    const db = emptyDb();
    const { code } = mintInvite(db, "Corrida");
    const dir = dirname(db);
    const outA = join(dir, "race-a.json");
    const outB = join(dir, "race-b.json");
    const attempt = (user: string, out: string) =>
      `${process.execPath} ${CLI} --db ${db} auth login --user ${user}` +
      ` --code ${code} > ${out} 2>&1`;

    const proc = spawnSync(
      "/bin/sh",
      ["-c", `${attempt(USER_A, outA)} & ${attempt(USER_B, outB)} & wait`],
      { encoding: "utf8", env: { ...process.env, TALLY_ACCESS_CODE: CODE } },
    );
    assert.equal(proc.status, 0, proc.stderr);

    const results = [outA, outB].map(
      (file) => JSON.parse(readFileSync(file, "utf8")) as Response,
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, `both redemptions succeeded: ${JSON.stringify(results)}`);
    assert.equal(winners[0].via, "invite");
    // The loser is told what is true by then: that code is spent.
    assert.equal(losers[0].error, "Código incorreto.");

    // One person registered, and the invite records that same one. The loser's
    // registration was rolled back with the failed consume.
    assert.equal(ok(db, "auth", "users").count, 1);
    const listed = inviteList(ok(db, "auth", "invites"))[0];
    assert.equal(listed.status, "redeemed");
    assert.equal(
      listed.redeemed_by,
      (winners[0].user as { telegram_user_id: string }).telegram_user_id,
    );
  });

  test("an invite code appears once, when it is minted, and never again", () => {
    const db = emptyDb();
    const minted = ok(db, "auth", "invite", "--label", "Namorada");
    const code = minted.code as string;
    // The mint is the one place it is allowed to be, message included.
    assert.ok((minted.message as string).includes(code));

    const bare = code.replaceAll("-", "");
    const outputs = [
      ok(db, "auth", "invites"),
      run(db, "auth", "login", "--user", USER_A, "--code", code),
      ok(db, "auth", "invites"),
      ok(db, "auth", "users"),
      ok(db, "auth", "status"),
      ok(db, "auth", "status", "--user", USER_A),
      // Spent, and then a stray guess: the failure paths are where a value escapes.
      run(db, "auth", "login", "--user", USER_B, "--code", code),
      run(db, "auth", "login", "--user", USER_B, "--code", bare.toLowerCase()),
      ok(db, "balance", "--user", USER_A),
      ok(db, "auth", "revoke", "--user", USER_A),
    ];
    for (const r of outputs) {
      const text = `${JSON.stringify(r)}\n${r._stderr}`;
      assert.ok(!text.includes(code), `the code leaked into: ${text.slice(0, 200)}`);
      assert.ok(!text.includes(bare), `the bare code leaked into: ${text.slice(0, 200)}`);
      // Not the hash either: it is not the code, but it is nobody's business.
      assert.ok(!text.includes("code_hash"), "the hash leaked");
    }
  });

  test("minting, listing and revoking are refused inside a chat turn", () => {
    // The essential one. A bot that can mint an invite is a bot that invites
    // whoever asks it to.
    const db = sharedDb();
    const { id } = mintInvite(db, "Namorada");
    const session = { HERMES_SESSION_USER_ID: USER_A, HERMES_SESSION_CHAT_TYPE: "dm" };

    for (const args of [
      ["auth", "invite", "--label", "Eu mesmo"],
      ["auth", "invites"],
      ["auth", "revoke-invite", String(id)],
      ["auth", "revoke", "--user", USER_A],
    ]) {
      const r = spawn(db, args, session);
      assert.equal(r.ok, false, `${args.join(" ")} ran from inside a session`);
      assert.match(r.error!, /operador/);
      assert.equal(r.code, undefined, "a code came back to a chat turn");
      assert.ok(!JSON.stringify(r).includes(USER_B), "the other person leaked anyway");
    }

    // Nothing happened: the invite is untouched and both people still work.
    assert.equal(inviteList(ok(db, "auth", "invites"))[0].status, "pending");
    assert.equal(spawn(db, ["balance"], session).ok, true);
    assert.equal(ok(db, "balance", "--user", USER_B).ok, true);
  });

  test("the private-chat fallback also counts as a chat turn here", () => {
    const db = freshDb();
    const r = spawn(db, ["auth", "invite", "--label", "Eu mesmo"], {
      HERMES_SESSION_USER_ID: undefined,
      HERMES_SESSION_CHAT_ID: USER_A,
      HERMES_SESSION_CHAT_TYPE: "dm",
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /operador/);
  });

  test("the shared code still works, and invites do not disturb it", () => {
    // Backward compatibility is the requirement: a documented, working install
    // must keep working. Both modes coexist.
    const db = emptyDb();
    const { code } = mintInvite(db, "Namorada");

    const shared = redeem(db, USER_A, CODE);
    assert.equal(shared.ok, true, shared.error);
    assert.equal(shared.via, "shared_code");
    assert.equal(shared.invite_id, null);
    // The pending invite was not consumed by somebody else's shared-code login.
    assert.equal(inviteList(ok(db, "auth", "invites"))[0].status, "pending");
    assert.equal(redeem(db, USER_B, code).ok, true);
  });

  test("with TALLY_ACCESS_CODE deleted, invites are the only way in", () => {
    // The prize: once everybody is registered the variable goes away, and no
    // standing secret is left for `env` to print.
    const db = emptyDb();
    const { code } = mintInvite(db, "Namorada");
    const noShared = { TALLY_ACCESS_CODE: undefined };

    const r = spawn(db, ["auth", "login", "--user", USER_A, "--code", code], noShared);
    assert.equal(r.ok, true, r.error);

    // The old shared code buys nothing, and says nothing about there having been
    // one: it is a wrong code, not a misconfigured server.
    const stale = spawn(db, ["auth", "login", "--user", USER_B, "--code", CODE], noShared);
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "Código incorreto.");
  });

  test("no shared code and no invite is the only unconfigured install", () => {
    const db = emptyDb();
    const r = spawn(db, ["auth", "login", "--user", USER_A, "--code", "x"], {
      TALLY_ACCESS_CODE: undefined,
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /não foi configurado/);
  });

  test("--hours sets the expiry and is bounded", () => {
    const db = emptyDb();
    const short = ok(db, "auth", "invite", "--label", "Curta", "--hours", "1");
    const invite = short.invite as { created_at: string; expires_at: string };
    assert.equal(short.hours, 1);
    assert.ok(invite.expires_at > invite.created_at);
    assert.equal(ok(db, "auth", "invite", "--label", "Padrão").hours, 48);

    assert.match(fails(db, "auth", "invite", "--label", "X", "--hours", "0"), /--hours/);
    assert.match(fails(db, "auth", "invite", "--label", "X", "--hours", "99999"), /--hours/);
    assert.match(fails(db, "auth", "invite", "--label", "X", "--hours", "abc"), /--hours/);
  });

  test("an invite says who it is for", () => {
    assert.match(fails(emptyDb(), "auth", "invite"), /--label/);
  });

  test("auth invites derives the status of every one of them", () => {
    const db = emptyDb();
    const pending = mintInvite(db, "Pendente");
    const spent = mintInvite(db, "Usada");
    const expired = mintInvite(db, "Vencida");
    const revoked = mintInvite(db, "Cancelada");
    redeem(db, USER_A, spent.code);
    expireInvite(db, expired.id);
    ok(db, "auth", "revoke-invite", String(revoked.id));

    const r = ok(db, "auth", "invites");
    assert.equal(r.count, 4);
    assert.equal(r.pending, 1);
    const byId = new Map(inviteList(r).map((i) => [i.id, i]));
    assert.equal(byId.get(pending.id)!.status, "pending");
    assert.equal(byId.get(spent.id)!.status, "redeemed");
    assert.equal(byId.get(expired.id)!.status, "expired");
    assert.equal(byId.get(revoked.id)!.status, "revoked");
    assert.equal(byId.get(spent.id)!.redeemed_by, USER_A);
    assert.equal(byId.get(pending.id)!.redeemed_by, null);
  });

  test("revoking a spent invite is refused, and points at the right command", () => {
    // Because it would look like it removed somebody's access, and it would not.
    const db = emptyDb();
    const { code, id } = mintInvite(db, "Usada");
    redeem(db, USER_A, code);
    const error = fails(db, "auth", "revoke-invite", String(id));
    assert.match(error, /já foi usado/);
    assert.match(error, /auth revoke --user/);
    assert.equal(ok(db, "balance", "--user", USER_A).ok, true);
  });

  test("revoke-invite needs a real invite number", () => {
    const db = emptyDb();
    assert.match(fails(db, "auth", "revoke-invite"), /convite/);
    assert.match(fails(db, "auth", "revoke-invite", "abc"), /convite/);
    assert.match(fails(db, "auth", "revoke-invite", "99"), /#99/);
  });
});

describe("revoking one person", () => {
  test("one person out, the other untouched, and no data deleted", () => {
    const db = sharedDb();
    ok(db, "add", "--amount", "100", "--description", "Mercado dele");
    ok(db, "add", "--amount", "40", "--description", "Bar dela", "--user", USER_B);

    const r = ok(db, "auth", "revoke", "--user", USER_A);
    assert.equal(r.telegram_user_id, USER_A);
    assert.equal(r.was_current, true);
    // The promise: the ledger is still theirs.
    assert.equal(r.transactions_preserved, 1);

    // Refused from the next command on, with the answer an unknown id gets.
    const revoked = run(db, "balance", "--user", USER_A);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.auth_required, true);
    assert.equal(revoked.error, run(db, "balance", "--user", "888888888").error);
    assert.equal((ok(db, "auth", "status", "--user", USER_A).user as { active: boolean }).active, false);

    // The scalpel, not the panic button: nobody else noticed.
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_B).total_count, 1);
    assert.equal(ok(db, "auth", "status", "--user", USER_B).current, true);
    assert.equal(ok(db, "auth", "status").auth_epoch, 0);

    // And the data is all there when they come back through a new invite.
    const { code } = mintInvite(db, "Ele de volta");
    const back = redeem(db, USER_A, code);
    assert.equal(back.ok, true, back.error);
    assert.equal(back.new_user, false);
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_A).total_count, 1);
  });

  test("a revoked user is refused by every data subcommand", () => {
    const db = freshDb();
    ok(db, "auth", "revoke", "--user", USER_A);
    for (const args of [
      ["add", "--amount", "10", "--description", "x"],
      ["ls"],
      ["balance"],
      ["summary"],
      ["report"],
      ["budget", "status"],
      ["account", "list"],
      ["category", "list"],
      ["recurring", "list"],
      ["goal", "list"],
      ["export"],
    ]) {
      const r = run(db, ...args, "--user", USER_A);
      assert.equal(r.ok, false, `${args[0]} let a revoked user through`);
      assert.equal(r.auth_required, true, `${args[0]} did not ask for a code`);
    }
  });

  test("revoke says so when the shared code would let them straight back in", () => {
    // Honest reporting: with TALLY_ACCESS_CODE still in the environment, this
    // person types it and is back. The revocation only becomes final when the
    // shared code is gone.
    const db = freshDb();
    const withShared = ok(db, "auth", "revoke", "--user", USER_A);
    assert.equal(withShared.shared_code_active, true);
    assert.match(withShared.message as string, /TALLY_ACCESS_CODE/);
    assert.equal(redeem(db, USER_A, CODE).ok, true);

    // With no shared code, there is nothing to warn about.
    const invited = emptyDb();
    const { code } = mintInvite(invited, "Namorada");
    spawn(invited, ["auth", "login", "--user", USER_A, "--code", code], {
      TALLY_ACCESS_CODE: undefined,
    });
    const clean = spawn(invited, ["auth", "revoke", "--user", USER_A], {
      TALLY_ACCESS_CODE: undefined,
    });
    assert.equal(clean.ok, true, clean.error);
    assert.equal(clean.shared_code_active, false);
    assert.ok(!(clean.message as string).includes("TALLY_ACCESS_CODE"));
  });

  test("logout-all is still the everybody version, and revoke is not", () => {
    const db = sharedDb();
    ok(db, "auth", "revoke", "--user", USER_A);
    // One session left, and `logout-all` still ends it.
    const out = ok(db, "auth", "logout-all");
    assert.equal(out.sessions_invalidated, 1);
    assert.equal(run(db, "balance", "--user", USER_B).auth_required, true);
  });

  test("auth revoke needs to be told who, and refuses a stranger", () => {
    const db = freshDb();
    assert.match(fails(db, "auth", "revoke"), /--user/);
    assert.match(fails(db, "auth", "revoke", "--user", "999999999"), /Não achei ninguém/);
    assert.match(fails(db, "auth", "revoke", "--user", "legacy"), /legacy/);
    // Nobody was cut off by any of that.
    assert.equal(ok(db, "balance", "--user", USER_A).ok, true);
  });
});

describe("who is calling", () => {
  test("the session's id is what counts, with no --user at all", () => {
    const db = emptyDb();
    const session = { HERMES_SESSION_USER_ID: USER_A, HERMES_SESSION_CHAT_TYPE: "dm" };
    assert.equal(
      spawn(db, ["auth", "login", "--code", CODE, "--name", "Geovane"], session).ok,
      true,
    );
    const r = spawn(db, ["auth", "status"], session);
    assert.equal(r.telegram_user_id, USER_A);
    assert.equal(r.identity_source, "session");
    assert.equal(r.current, true);

    ok(db, "add", "--amount", "42", "--description", "Uber", "--user", USER_A);
    assert.equal(spawn(db, ["ls", "--period", "all"], session).total_count, 1);
  });

  test("a --user that disagrees with the session is refused", () => {
    // The anti-impersonation control: no silent preference for either value.
    const db = sharedDb();
    const r = spawn(db, ["balance", "--user", USER_B], {
      HERMES_SESSION_USER_ID: USER_A,
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /outra pessoa/);
    assert.notEqual(r.auth_required, true);
  });

  test("a --user that merely repeats the session is fine", () => {
    const db = freshDb();
    const r = spawn(db, ["balance", "--user", USER_A], {
      HERMES_SESSION_USER_ID: USER_A,
    });
    assert.equal(r.ok, true);
  });

  test("an empty session id is not an identity", () => {
    // Hermes leaves it empty on its anonymised path; falling back to "" would
    // pool every anonymous caller into one ledger.
    const db = freshDb();
    const r = spawn(db, ["balance"], { HERMES_SESSION_USER_ID: "" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /identificar/);
  });

  test("no identity at all is refused, and nothing is created", () => {
    const db = freshDb();
    const r = spawn(db, ["add", "--amount", "10", "--description", "x"]);
    assert.equal(r.ok, false);
    assert.match(r.error!, /identificar/);
    assert.equal(ok(db, "ls", "--period", "all").total_count, 0);
  });

  test("a private chat id stands in for a missing user id", () => {
    const db = emptyDb();
    const session = {
      HERMES_SESSION_USER_ID: undefined,
      HERMES_SESSION_CHAT_ID: USER_A,
      HERMES_SESSION_CHAT_TYPE: "dm",
    };
    assert.equal(spawn(db, ["auth", "login", "--code", CODE], session).ok, true);
    assert.equal(spawn(db, ["auth", "status"], session).telegram_user_id, USER_A);
  });

  test("a group chat id never stands in for a person", () => {
    const db = freshDb();
    const r = spawn(db, ["balance"], {
      HERMES_SESSION_USER_ID: undefined,
      HERMES_SESSION_CHAT_ID: "-100200300",
      HERMES_SESSION_CHAT_TYPE: "group",
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /identificar/);
  });

  test("--user works outside a session, which is what cron and the Makefile use", () => {
    // Documented deliberately: with no session identity at all, `--user` is
    // honoured with nothing else to check it against. That is not a hole being
    // tolerated, it is the operator path — `make balance TG_USER=…` and every cron
    // prompt depend on it, because a cron run has no inbound message and therefore
    // no session to bind.
    //
    // It is also why none of this is a security boundary: the agent holds a shell
    // as the same uid, so `env -u HERMES_SESSION_USER_ID node fin.ts ... --user
    // <other person>` is always available to it, as is opening tally.db directly.
    // The boundary is the Hermes gateway allowlist, one level up. What the checks
    // here buy is that the ordinary path cannot go wrong by accident, and that
    // going around it takes a visibly strange command.
    const db = freshDb();
    assert.equal(spawn(db, ["balance", "--user", USER_A]).ok, true);
    assert.equal(spawn(db, ["auth", "users"]).ok, true);
  });

  test("--user has to look like a Telegram id", () => {
    const db = freshDb();
    for (const bad of ["geovane", "12", "1234567890123456789012", "111111111 ; ls", "1e9"]) {
      const r = spawn(db, ["balance", "--user", bad]);
      assert.equal(r.ok, false, `--user ${JSON.stringify(bad)} was accepted`);
      assert.match(r.error!, /id numérico/);
      // Not the auth prompt: this is a malformed call, not a missing session.
      assert.notEqual(r.auth_required, true);
    }
    // A group chat id is negative, and `--user -100…` never even reaches the
    // validation — parseArgs rejects a value that looks like another option. The
    // `=` form is the one that gets through to it.
    const negative = spawn(db, ["balance", "--user=-100200300"]);
    assert.equal(negative.ok, false);
    assert.match(negative.error!, /id numérico/);
  });

  test("--user legacy is refused by name", () => {
    // Migration 2 parks pre-multi-user rows under a placeholder called `legacy`.
    // `--user legacy` used to walk straight into that ledger.
    const db = freshDb();
    const r = spawn(db, ["ls", "--user", "legacy"]);
    assert.equal(r.ok, false);
    assert.match(r.error!, /legacy/);
    assert.match(r.error!, /adopt-legacy/);
  });

  test("operator commands refuse to run inside a chat turn", () => {
    // Nothing here needed any authentication before: a message could ask the bot
    // to list both people's Telegram ids and chat ids, or to log everybody out on
    // repeat. They are host commands, so they refuse when the gateway bound a
    // session — which is the only situation where a chat is what is asking.
    //
    // A guardrail, not a boundary: the agent can drop the variable. It stops the
    // bot doing this *because it was asked to*.
    const db = sharedDb();
    const session = { HERMES_SESSION_USER_ID: USER_A, HERMES_SESSION_CHAT_TYPE: "dm" };

    // `auth status` is not in this list on purpose: with a session it scopes to
    // the caller instead of refusing (see the next test). Only its everybody form
    // is operator-only, and that form cannot be reached with a session bound.
    for (const args of [
      ["auth", "users"],
      ["auth", "logout-all"],
      ["auth", "unlock", "--user", USER_A],
      ["auth", "adopt-legacy", "--user", USER_A],
    ]) {
      const r = spawn(db, args, session);
      assert.equal(r.ok, false, `${args.join(" ")} ran from inside a session`);
      assert.match(r.error!, /operador/);
      assert.ok(!JSON.stringify(r).includes(USER_B), "the other person leaked anyway");
    }

    // Still live afterwards: `logout-all` did not take effect.
    assert.equal(spawn(db, ["balance"], session).ok, true);
  });

  test("auth status with a session shows only the caller", () => {
    const db = sharedDb();
    const r = spawn(db, ["auth", "status"], {
      HERMES_SESSION_USER_ID: USER_A,
      HERMES_SESSION_CHAT_TYPE: "dm",
    });
    assert.equal(r.ok, true);
    assert.equal(r.telegram_user_id, USER_A);
    assert.equal(r.current, true);
    // No roster, no count, no sign of anyone else.
    assert.equal(r.users, undefined);
    assert.equal(r.count, undefined);
    assert.ok(!JSON.stringify(r).includes(USER_B));
  });

  test("the private-chat fallback counts as a session for the operator check", () => {
    // Same reasoning as above: a dm whose chat id stands in for the user id is
    // still a chat turn, so the operator commands stay shut.
    const db = sharedDb();
    const r = spawn(db, ["auth", "users"], {
      HERMES_SESSION_USER_ID: undefined,
      HERMES_SESSION_CHAT_ID: USER_A,
      HERMES_SESSION_CHAT_TYPE: "dm",
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /operador/);
  });
});

describe("isolation between the two people", () => {
  /** Both ledgers populated, deliberately using the same account name. */
  function populatedPair(): string {
    const db = sharedDb();

    ok(db, "account", "add", "--name", "Nubank", "--type", "card", "--limit", "5000");
    ok(db, "add", "--amount", "100", "--description", "Mercado dela-nao",
      "--category", "Mercado", "--tags", "meu", "--account", "Nubank");
    ok(db, "add", "--type", "income", "--amount", "7000", "--description", "Salário A",
      "--category", "Salário");
    ok(db, "budget", "set", "--category", "Alimentação", "--limit", "150");
    ok(db, "goal", "add", "--name", "Notebook", "--target", "5000");
    ok(db, "category", "add", "--name", "Cerveja artesanal", "--parent", "Lazer");
    ok(db, "recurring", "add", "--description", "Aluguel A", "--amount", "1500",
      "--category", "Aluguel", "--day", "10");

    const b = (...args: string[]) => ok(db, ...args, "--user", USER_B);
    b("account", "add", "--name", "Nubank", "--type", "checking");
    b("add", "--amount", "40", "--description", "Bar dele-nao", "--category", "Bar",
      "--tags", "dela", "--account", "Nubank");
    b("add", "--type", "income", "--amount", "3000", "--description", "Salário B",
      "--category", "Salário");
    b("budget", "set", "--category", "Lazer", "--limit", "80");
    b("goal", "add", "--name", "Viagem", "--target", "9000");
    b("category", "add", "--name", "Cerâmica", "--parent", "Lazer");
    b("recurring", "add", "--description", "Academia B", "--amount", "120",
      "--category", "Academia", "--day", "5");

    return db;
  }

  test("listings show only your own transactions", () => {
    const db = populatedPair();
    const mine = ok(db, "ls", "--period", "all");
    assert.equal(mine.total_count, 2);
    const text = JSON.stringify(mine);
    assert.ok(!text.includes("Bar dele-nao"));
    assert.ok(!text.includes("Salário B"));

    const hers = ok(db, "ls", "--period", "all", "--user", USER_B);
    assert.equal(hers.total_count, 2);
    assert.ok(!JSON.stringify(hers).includes("Mercado dela-nao"));
  });

  test("summary, report and balance never mix the two", () => {
    const db = populatedPair();

    const sumA = ok(db, "summary", "--period", "month");
    assert.equal(sumA.expenses_cents, 10000);
    assert.equal(sumA.income_cents, 700000);

    const sumB = ok(db, "summary", "--period", "month", "--user", USER_B);
    assert.equal(sumB.expenses_cents, 4000);
    assert.equal(sumB.income_cents, 300000);

    const reportA = ok(db, "report", "--period", "month").text as string;
    assert.match(reportA, /R\$ 100,00/);
    assert.ok(!reportA.includes("Bar dele-nao"));
    const reportB = ok(db, "report", "--period", "month", "--user", USER_B).text as string;
    assert.ok(!reportB.includes("Mercado dela-nao"));

    // Same account name on both sides, separate balances.
    const nubankA = (ok(db, "balance").accounts as Record<string, unknown>[])
      .find((c) => c.name === "Nubank")!;
    const nubankB = (ok(db, "balance", "--user", USER_B).accounts as Record<string, unknown>[])
      .find((c) => c.name === "Nubank")!;
    assert.notEqual(nubankA.id, nubankB.id);
    assert.equal(nubankA.type, "card");
    assert.equal(nubankB.type, "checking");
    assert.equal(nubankA.balance_cents, -10000);
    assert.equal(nubankB.balance_cents, -4000);
    // Two accounts each (Carteira + Nubank), never four.
    assert.equal((ok(db, "balance").accounts as unknown[]).length, 2);
  });

  test("both can name an account Nubank without colliding", () => {
    const db = sharedDb();
    ok(db, "account", "add", "--name", "Nubank");
    // The UNIQUE is per user, so this is not a duplicate.
    ok(db, "account", "add", "--name", "Nubank", "--user", USER_B);
    // But a second one for the same person still is.
    assert.match(fails(db, "account", "add", "--name", "Nubank"), /Já existe/);
  });

  test("budget statuses are computed from your spending only", () => {
    const db = populatedPair();
    const a = ok(db, "budget", "status").budgets as
      { category: string; spent_cents: number }[];
    assert.equal(a.length, 1);
    assert.equal(a[0].category, "Alimentação");
    assert.equal(a[0].spent_cents, 10000);

    const b = ok(db, "budget", "status", "--user", USER_B).budgets as
      { category: string; spent_cents: number }[];
    assert.equal(b.length, 1);
    assert.equal(b[0].category, "Lazer");
    assert.equal(b[0].spent_cents, 4000);
  });

  test("alerts fire per person and are marked per person", () => {
    const db = sharedDb();
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100");
    ok(db, "budget", "set", "--category", "Lazer", "--limit", "100", "--user", USER_B);
    ok(db, "add", "--amount", "150", "--description", "Show", "--category", "Eventos");
    // B has a limit and is spending against it, comfortably inside — so her
    // `silent` below means "her budget is fine", not "she has no data". With no
    // spending at all the assertion would pass for a reason that has nothing to do
    // with the alert being scoped per person.
    ok(db, "add", "--amount", "20", "--description", "Bar", "--category", "Bar",
      "--user", USER_B);

    assert.equal(ok(db, "alerts", "--mark").count, 1);
    assert.equal(ok(db, "alerts").silent, true);
    // Marking A's alert must not silence B's, and B's own limit is at 20%.
    const hers = ok(db, "alerts", "--user", USER_B);
    assert.equal(hers.silent, true);
    assert.equal(
      (ok(db, "budget", "status", "--user", USER_B).budgets as { pct: number }[])[0].pct,
      20,
    );

    ok(db, "add", "--amount", "150", "--description", "Show", "--category", "Eventos",
      "--user", USER_B);
    assert.equal(ok(db, "alerts", "--user", USER_B).count, 1);
  });

  test("search and tags do not cross over", () => {
    const db = populatedPair();
    assert.equal(ok(db, "search", "Bar").count, 0);
    assert.equal(ok(db, "search", "Bar", "--user", USER_B).count, 1);
    assert.equal(ok(db, "ls", "--tag", "dela").total_count, 0);
    assert.equal(ok(db, "ls", "--tag", "dela", "--user", USER_B).total_count, 1);
    assert.equal(ok(db, "ls", "--tag", "meu").total_count, 1);
  });

  test("goals, categories and fixed costs stay separate", () => {
    const db = populatedPair();
    const goalsA = ok(db, "goal", "list").goals as { name: string }[];
    assert.deepEqual(goalsA.map((g) => g.name), ["Notebook"]);
    const goalsB = ok(db, "goal", "list", "--user", USER_B).goals as { name: string }[];
    assert.deepEqual(goalsB.map((g) => g.name), ["Viagem"]);

    // A goal only the other person has is not depositable into.
    assert.match(
      fails(db, "goal", "deposit", "--name", "Viagem", "--amount", "10"),
      /Não achei/,
    );
    // And both may use the same goal name.
    ok(db, "goal", "add", "--name", "Viagem", "--target", "1000");

    const catsA = ok(db, "category", "list").categories as Record<string, { children: string[] }>;
    assert.ok(catsA["Lazer"].children.includes("Cerveja artesanal"));
    assert.ok(!catsA["Lazer"].children.includes("Cerâmica"));

    const recA = ok(db, "recurring", "list").recurring as { description: string }[];
    assert.deepEqual(recA.map((r) => r.description), ["Aluguel A"]);
    assert.equal(ok(db, "recurring", "list").count, 1);
    const recB = ok(db, "recurring", "list", "--user", USER_B).recurring as
      { description: string }[];
    assert.deepEqual(recB.map((r) => r.description), ["Academia B"]);
  });

  test("recurring apply only posts your own fixed costs", () => {
    const db = sharedDb();
    // Due today, so `apply` has something to do on any day of the month.
    const dueToday = today().slice(8);
    ok(db, "recurring", "add", "--description", "Aluguel A", "--amount", "1500",
      "--category", "Aluguel", "--day", dueToday);
    ok(db, "recurring", "add", "--description", "Academia B", "--amount", "120",
      "--category", "Academia", "--day", dueToday, "--user", USER_B);

    ok(db, "recurring", "apply");
    assert.equal(ok(db, "ls", "--period", "all").total_count, 1);
    // B's entry was not generated by A's run.
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_B).total_count, 0);

    ok(db, "recurring", "apply", "--user", USER_B);
    const hers = ok(db, "ls", "--period", "all", "--user", USER_B);
    assert.equal(hers.total_count, 1);
    assert.match(JSON.stringify(hers), /Academia B/);
  });

  test("an export contains only your own rows, in your own file", () => {
    const db = populatedPair();
    const dest = exportDir(db, "pair");
    const a = ok(db, "export", "--period", "month", "--dest", dest);
    const b = ok(db, "export", "--period", "month", "--dest", dest, "--user", USER_B);

    assert.equal(a.count, 2);
    assert.equal(b.count, 2);
    // Different files: one overwriting the other would attach the wrong
    // spreadsheet to the wrong chat.
    assert.notEqual(a.file, b.file);

    const contentA = readFileSync(a.file as string, "utf8");
    assert.match(contentA, /Mercado dela-nao/);
    assert.ok(!contentA.includes("Bar dele-nao"));

    const contentB = readFileSync(b.file as string, "utf8");
    assert.match(contentB, /Bar dele-nao/);
    assert.ok(!contentB.includes("Mercado dela-nao"));
  });

  test("a transaction id from the other person cannot be edited", () => {
    // The sharpest failure mode: a raw id is all it would take.
    const db = sharedDb();
    const mine = ok(db, "add", "--amount", "100", "--description", "Meu",
      "--category", "Mercado");
    const hers = ok(db, "add", "--amount", "40", "--description", "Dela",
      "--category", "Bar", "--user", USER_B);
    assert.notEqual(mine.id, hers.id);

    assert.match(
      fails(db, "edit", String(hers.id), "--amount", "999"),
      new RegExp(`#${hers.id}`),
    );
    // Untouched, not silently changed.
    const stillHers = ok(db, "ls", "--period", "all", "--user", USER_B)
      .transactions as { amount_cents: number; description: string }[];
    assert.equal(stillHers[0].amount_cents, 4000);
    assert.equal(stillHers[0].description, "Dela");
  });

  test("a transaction id from the other person cannot be deleted", () => {
    const db = sharedDb();
    ok(db, "add", "--amount", "100", "--description", "Meu", "--category", "Mercado");
    const hers = ok(db, "add", "--amount", "40", "--description", "Dela",
      "--category", "Bar", "--user", USER_B);

    assert.match(fails(db, "rm", String(hers.id)), new RegExp(`#${hers.id}`));
    assert.equal(ok(db, "ls", "--period", "all", "--user", USER_B).total_count, 1);
  });

  test("an instalment series belonging to the other person is not deletable by group", () => {
    const db = sharedDb();
    const hers = ok(db, "add", "--amount", "900", "--description", "TV dela",
      "--category", "Eletrônicos", "--installments", "3", "--user", USER_B);
    const firstId = (hers.installments as { id: number }[])[0].id;
    assert.match(fails(db, "rm", String(firstId), "--group"), new RegExp(`#${firstId}`));
    // Nothing was removed: she can still delete all three herself. (`--period
    // all` would only show the first, since the other two fall in the future.)
    assert.equal(ok(db, "rm", String(firstId), "--group", "--user", USER_B).count, 3);
  });

  test("the other person's transaction cannot be read by id either", () => {
    const db = sharedDb();
    const hers = ok(db, "add", "--amount", "40", "--description", "Dela",
      "--category", "Bar", "--user", USER_B);
    // `edit` with no field is the cheapest probe for "does this id exist"; it
    // must not answer differently for somebody else's id.
    const mine = ok(db, "add", "--amount", "10", "--description", "Meu");
    assert.match(fails(db, "edit", String(mine.id)), /Nada para alterar/);
    assert.match(fails(db, "edit", String(hers.id)), new RegExp(`#${hers.id}`));
  });

  test("a category from the other person is not usable as a filter", () => {
    const db = sharedDb();
    ok(db, "category", "add", "--name", "Cerâmica xyz", "--parent", "Lazer",
      "--user", USER_B);
    assert.match(fails(db, "ls", "--category", "Cerâmica xyz"), /não existe/);
  });

  test("the default account setting is per person", () => {
    const db = sharedDb();
    ok(db, "account", "add", "--name", "Inter");
    ok(db, "account", "default", "--name", "Inter");
    assert.equal(tx(ok(db, "add", "--amount", "10", "--description", "x")).account, "Inter");
    // B never chose one, so she still gets her own wallet.
    const hers = ok(db, "add", "--amount", "10", "--description", "x", "--user", USER_B);
    assert.equal(tx(hers).account, "Carteira");
  });
});
