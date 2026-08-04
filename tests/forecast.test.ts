/**
 * Tests for the end-of-month forecast.
 *
 * Fixtures are built against the real schema through `db.ts` (`migrate`,
 * `seedUser`, `resolveCategory`), never a hand-written CREATE TABLE — a copy of
 * the schema in here would drift away from the migrations and start passing for
 * the wrong reasons.
 *
 * What is worth testing in a projection is not "does it return a number": it is
 * the arithmetic, the failure mode where one big purchase early in the month
 * projects a catastrophe, the double counting of a fixed cost that has already
 * been posted, and — since two people share this database — that neither
 * forecast can see the other's money.
 *
 *     node --test tests/forecast.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connect,
  migrate,
  now,
  resolveCategory,
  seedUser,
  type Db,
} from "../skills/finance/scripts/db.ts";
import { forecast } from "../skills/finance/scripts/forecast.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "skills", "finance", "scripts", "forecast.ts");

/** August 2026 has 31 days and starts on a Saturday. Every fixture lives there. */
const MONTH = "2026-08";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  db: Db;
  path: string;
  userId: number;
}

function newDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "tally-forecast-"));
  const path = join(dir, "tally.db");
  const db = connect(path);
  migrate(db);
  return { db, path };
}

/**
 * A seeded user.
 *
 * Only the three columns every version of the schema has: the forecast does not
 * read anything to do with sessions, and the auth columns are still moving
 * around in `db.ts`. Authentication is `fin.ts`'s business, not this module's.
 */
function addUser(db: Db, telegramId: string, name: string): number {
  const info = db
    .prepare(
      "INSERT INTO users (telegram_user_id, display_name, created_at) VALUES (?, ?, ?)",
    )
    .run(telegramId, name, now());
  const userId = Number(info.lastInsertRowid);
  seedUser(db, userId);
  return userId;
}

function fixture(): Fixture {
  const { db, path } = newDb();
  return { db, path, userId: addUser(db, "111111111", "Geovane") };
}

interface ExpenseOptions {
  category?: string;
  recurringId?: number;
  installmentTotal?: number;
  description?: string;
}

function expense(
  db: Db,
  userId: number,
  date: string,
  cents: number,
  o: ExpenseOptions = {},
): number {
  const info = db
    .prepare(
      "INSERT INTO transactions (user_id, type, amount_cents, description, date," +
        " category_id, account_id, source, recurring_id, installment_num," +
        " installment_total, created_at, updated_at)" +
        " VALUES (?, 'expense', ?, ?, ?, ?, NULL, 'test', ?, ?, ?, ?, ?)",
    )
    .run(
      userId,
      cents,
      o.description ?? "Gasto",
      date,
      o.category ? resolveCategory(db, userId, o.category) : null,
      o.recurringId ?? null,
      o.installmentTotal ? 2 : null,
      o.installmentTotal ?? null,
      now(),
      now(),
    );
  return Number(info.lastInsertRowid);
}

/** The same amount every day in `[start, end]`, so weekend factors stay at 1. */
function dailyExpenses(
  db: Db,
  userId: number,
  start: string,
  end: string,
  cents: number,
  o: ExpenseOptions = {},
): void {
  for (let day = Number(start.slice(8)); day <= Number(end.slice(8)); day++) {
    expense(db, userId, `${start.slice(0, 8)}${String(day).padStart(2, "0")}`, cents, o);
  }
}

interface RecurringOptions {
  frequency?: string;
  category?: string;
  endsOn?: string;
}

function recurring(
  db: Db,
  userId: number,
  description: string,
  cents: number,
  day: number,
  nextDate: string,
  o: RecurringOptions = {},
): number {
  const info = db
    .prepare(
      "INSERT INTO recurring (user_id, description, type, amount_cents, category_id," +
        " account_id, frequency, day, next_date, ends_on, active, created_at)" +
        " VALUES (?, ?, 'expense', ?, ?, NULL, ?, ?, ?, ?, 1, ?)",
    )
    .run(
      userId,
      description,
      cents,
      o.category ? resolveCategory(db, userId, o.category) : null,
      o.frequency ?? "monthly",
      day,
      nextDate,
      o.endsOn ?? null,
      now(),
    );
  return Number(info.lastInsertRowid);
}

function budget(
  db: Db,
  userId: number,
  category: string | null,
  cents: number,
  alertPct = 80,
): void {
  db.prepare(
    "INSERT INTO budgets (user_id, category_id, month, limit_cents, alert_pct, created_at)" +
      " VALUES (?, ?, NULL, ?, ?, ?)",
  ).run(
    userId,
    category ? resolveCategory(db, userId, category) : null,
    cents,
    alertPct,
    now(),
  );
}

/* -------------------------------------------------------------------------- */

describe("the projection", () => {
  test("known spending over known days projects the arithmetic", () => {
    const { db, userId } = fixture();
    // R$ 100,00 a day for the first ten days of a 31-day month.
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.days_elapsed, 10);
    assert.equal(f.days_remaining, 21);
    assert.equal(f.spent_cents, 100000);
    assert.equal(f.rate.basis, "current");
    assert.equal(f.rate.cents_per_day, 10000);
    // 10 days of history is not enough to say anything about weekends.
    assert.equal(f.rate.weekend_adjusted, false);
    assert.equal(f.variable_estimate_cents, 21 * 10000);
    assert.equal(f.projected_total_cents, 310000);
    assert.equal(f.projected_total_fmt, "R$ 3.100,00");
    db.close();
  });

  test("day one with no data does not divide by zero and claims nothing", () => {
    const { db, userId } = fixture();

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-01" });

    assert.equal(f.days_elapsed, 1);
    assert.equal(f.days_remaining, 30);
    assert.equal(f.spent_cents, 0);
    assert.equal(f.rate.basis, "insufficient");
    assert.equal(f.rate.cents_per_day, null);
    assert.equal(f.variable_estimate_cents, null);
    assert.equal(f.projected_total_cents, 0);
    assert.equal(f.confidence, "none");
    assert.equal(f.silent, true);
    // Nothing infinite or NaN leaked out of a division by an empty month.
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(f)));
    for (const value of [
      f.projected_total_cents,
      f.certain_cents,
      f.estimated_cents,
      f.certain_pct,
      f.rate.weight_current,
    ]) {
      assert.ok(Number.isFinite(value), `${value} is not a finite number`);
    }
    assert.match(f.text, /histórico suficiente/);
    db.close();
  });

  test("one big purchase early in the month is smoothed, not extrapolated", () => {
    const { db, userId } = fixture();
    // A calm previous month: R$ 50,00 a day, all 31 days of July.
    dailyExpenses(db, userId, "2026-07-01", "2026-07-31", 5000);
    // Then a single R$ 2.000,00 purchase on the 2nd of August.
    expense(db, userId, "2026-08-02", 200000, { description: "Notebook" });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-02" });

    assert.equal(f.rate.basis, "blend");
    assert.equal(f.rate.current_cents_per_day, 100000); // the naive rate
    assert.equal(f.rate.history_cents_per_day, 5000);
    // Two days in, the current month carries 2/31 of the weight.
    assert.equal(f.rate.weight_current, 0.06);
    // The naive projection would be 200000 + 29 * 100000 = R$ 31.000,00.
    assert.ok(
      f.projected_total_cents < 800000,
      `projected ${f.projected_total_cents} is still absurd`,
    );
    assert.ok(f.projected_total_cents > 200000, "the purchase itself must be counted");
    // And the blended rate stays within sight of the person's own history.
    assert.ok(f.rate.cents_per_day! < 3 * 5000);
    db.close();
  });

  test("the blend leans on the current month as the month goes by", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-07-01", "2026-07-31", 5000);
    dailyExpenses(db, userId, "2026-08-01", "2026-08-24", 10000);

    const early = forecast(db, userId, { month: MONTH, asOf: "2026-08-02" });
    const late = forecast(db, userId, { month: MONTH, asOf: "2026-08-24" });

    assert.ok(late.rate.weight_current > early.rate.weight_current);
    // Late in the month the rate has to be close to what this month actually is.
    assert.ok(late.rate.cents_per_day! > 8000, `got ${late.rate.cents_per_day}`);
    db.close();
  });

  test("a month that has not started yet is projected from history alone", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-07-01", "2026-07-31", 5000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-07-20" });

    assert.equal(f.days_elapsed, 0);
    assert.equal(f.days_remaining, 31);
    assert.equal(f.spent_cents, 0);
    assert.equal(f.rate.basis, "history");
    assert.equal(f.rate.weight_current, 0);
    assert.equal(f.rate.cents_per_day, 5000);
    assert.equal(f.projected_total_cents, 31 * 5000);
    db.close();
  });

  test("an empty previous month is not read as a month of spending zero", () => {
    const { db, userId } = fixture();
    // June has data, July none (the bot was not in use), August is starting.
    dailyExpenses(db, userId, "2026-06-01", "2026-06-30", 5000);
    dailyExpenses(db, userId, "2026-08-01", "2026-08-05", 6000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-05" });

    assert.deepEqual(f.rate.history_months, ["2026-06"]);
    assert.equal(f.rate.history_cents_per_day, 5000);
    db.close();
  });
});

describe("fixed costs and instalments", () => {
  test("a fixed cost due later this month is counted exactly once", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    recurring(db, userId, "Aluguel", 150000, 20, "2026-08-20", { category: "Aluguel" });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.fixed_pending.length, 1);
    assert.equal(f.fixed_pending[0].date, "2026-08-20");
    assert.equal(f.fixed_pending_cents, 150000);
    // 100000 spent + 150000 rent + 21 days * 10000 of variable spending.
    assert.equal(f.projected_total_cents, 460000);
    db.close();
  });

  test("the same fixed cost is not counted twice once it has been posted", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    const id = recurring(db, userId, "Aluguel", 150000, 20, "2026-08-20", {
      category: "Aluguel",
    });
    // `recurring apply` generated it: same recurring_id, same date.
    expense(db, userId, "2026-08-20", 150000, {
      category: "Aluguel",
      recurringId: id,
      description: "Aluguel",
    });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.fixed_pending.length, 0);
    assert.equal(f.fixed_pending_cents, 0);
    // It moved from "projected" to "scheduled", and the total did not budge.
    assert.equal(f.scheduled_cents, 150000);
    assert.equal(f.projected_total_cents, 460000);
    db.close();
  });

  test("a posted fixed cost stays out of the daily rate", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    const id = recurring(db, userId, "Aluguel", 150000, 5, "2026-09-05", {
      category: "Aluguel",
    });
    // Already in the ledger, earlier this month.
    expense(db, userId, "2026-08-05", 150000, {
      category: "Aluguel",
      recurringId: id,
      description: "Aluguel",
    });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.spent_cents, 250000);
    assert.equal(f.fixed_pending_cents, 0);
    // R$ 1.500,00 of rent must not become R$ 150,00 a day of projected spending.
    assert.equal(f.rate.cents_per_day, 10000);
    assert.equal(f.projected_total_cents, 460000);
    db.close();
  });

  test("a recurring entry that has ended is not projected", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    recurring(db, userId, "Curso", 30000, 20, "2026-08-20", { endsOn: "2026-07-31" });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.fixed_pending.length, 0);
    db.close();
  });

  test("a weekly fixed cost is counted on every occurrence left in the month", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    // Every Tuesday; the 11th, 18th and 25th are the ones still to come.
    recurring(db, userId, "Faxina", 12000, 1, "2026-08-04", { frequency: "weekly" });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.deepEqual(
      f.fixed_pending.map((x) => x.date),
      ["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25"],
    );
    // The 4th is overdue and unposted — `recurring apply` still owes it, so it
    // belongs in the month either way.
    assert.equal(f.fixed_pending[0].overdue, true);
    assert.equal(f.fixed_pending[1].overdue, false);
    assert.equal(f.fixed_pending_cents, 4 * 12000);
    db.close();
  });

  test("an overdue fixed cost still counts, once", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    // The bot was down: due on the 3rd, never posted, `next_date` never advanced.
    recurring(db, userId, "Internet", 20000, 3, "2026-08-03", { category: "Internet" });
    budget(db, userId, "Moradia", 15000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.fixed_pending.length, 1);
    assert.equal(f.fixed_pending[0].overdue, true);
    assert.equal(f.projected_total_cents, 100000 + 20000 + 21 * 10000);
    // An overdue charge already breaks a R$ 150,00 limit, so the crossing is the
    // first day left rather than some day later in the month.
    const b = f.budgets.find((x) => x.category === "Moradia")!;
    assert.equal(b.crossing_date, "2026-08-11");
    db.close();
  });

  test("a future instalment counts as certain, not as an estimate", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    expense(db, userId, "2026-08-25", 60000, {
      installmentTotal: 3,
      description: "Geladeira 2/3",
    });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(f.scheduled_cents, 60000);
    assert.equal(f.scheduled_count, 1);
    assert.equal(f.certain_cents, 160000); // spent + scheduled
    // The instalment is neither projected as daily spending nor estimated twice.
    assert.equal(f.rate.cents_per_day, 10000);
    assert.equal(f.estimated_cents, 210000);
    assert.equal(f.projected_total_cents, 370000);
    db.close();
  });
});

describe("per budget", () => {
  test("the crossing day is right for a clean case", () => {
    const { db, userId } = fixture();
    // R$ 15,00 a day in Alimentação for ten days, against a R$ 300,00 limit.
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 1500, { category: "Mercado" });
    budget(db, userId, "Alimentação", 30000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });
    const b = f.budgets.find((x) => x.category.startsWith("Alimentação"))!;

    assert.equal(b.spent_cents, 15000);
    // R$ 150,00 left at R$ 15,00 a day: ten more days, so the 20th.
    assert.equal(b.crossing_day, 20);
    assert.equal(b.crossing_date, "2026-08-20");
    assert.equal(b.projected_cents, 46500);
    assert.equal(b.over_projected, true);
    assert.equal(b.overflow_cents, 16500);
    assert.equal(b.status, "over");
    assert.equal(b.already_over, false);
    assert.equal(b.current_status, "ok"); // 50% used today
    assert.match(f.text, /estoura dia 20/);
    db.close();
  });

  test("a budget the projection stays inside is reported, and stays quiet", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 1500, { category: "Mercado" });
    budget(db, userId, "Alimentação", 200000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });
    const b = f.budgets[0];

    assert.equal(b.crossing_day, null);
    assert.equal(b.over_projected, false);
    assert.equal(b.status, "ok");
    assert.equal(f.silent, true);
    db.close();
  });

  test("a limit already passed is reported as passed, not as a forecast", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 5000, { category: "Mercado" });
    budget(db, userId, "Alimentação", 30000);

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });
    const b = f.budgets[0];

    assert.equal(b.already_over, true);
    assert.equal(b.crossing_date, null);
    assert.equal(f.silent, false);
    assert.match(f.text, /limite já foi passado/);
    db.close();
  });

  test("a fixed cost still to be posted can be what crosses the budget", () => {
    const { db, userId } = fixture();
    budget(db, userId, "Moradia", 100000);
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000); // uncategorised
    recurring(db, userId, "Aluguel", 150000, 20, "2026-08-20", { category: "Aluguel" });

    const f = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });
    const b = f.budgets.find((x) => x.category === "Moradia")!;

    assert.equal(b.fixed_pending_cents, 150000);
    assert.equal(b.crossing_day, 20);
    db.close();
  });
});

describe("isolation between the two people", () => {
  test("each forecast uses only its own data", () => {
    const { db } = newDb();
    const a = addUser(db, "111111111", "Geovane");
    const b = addUser(db, "222222222", "Namorada");

    dailyExpenses(db, a, "2026-08-01", "2026-08-10", 10000);
    dailyExpenses(db, b, "2026-08-01", "2026-08-10", 50000);
    recurring(db, b, "Academia", 12000, 15, "2026-08-15");
    budget(db, b, "Alimentação", 30000);

    const fa = forecast(db, a, { month: MONTH, asOf: "2026-08-10" });
    const fb = forecast(db, b, { month: MONTH, asOf: "2026-08-10" });

    assert.equal(fa.spent_cents, 100000);
    assert.equal(fa.projected_total_cents, 310000);
    assert.equal(fa.fixed_pending.length, 0, "A must not see B's fixed costs");
    assert.equal(fa.budgets.length, 0, "A must not see B's budgets");

    assert.equal(fb.spent_cents, 500000);
    assert.equal(fb.rate.cents_per_day, 50000);
    assert.equal(fb.fixed_pending_cents, 12000);
    assert.equal(fb.projected_total_cents, 500000 + 12000 + 21 * 50000);
    db.close();
  });
});

describe("the text", () => {
  test("no markdown table, no judgement, Brazilian money", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-07-01", "2026-07-31", 5000);
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000, { category: "Mercado" });
    recurring(db, userId, "Aluguel", 150000, 20, "2026-08-20", { category: "Aluguel" });
    budget(db, userId, "Alimentação", 30000);
    budget(db, userId, null, 500000);

    const { text } = forecast(db, userId, { month: MONTH, asOf: "2026-08-10" });

    // Telegram does not render tables, and pipes are how one gets written.
    assert.ok(!text.includes("|"), "the text contains a markdown table");
    assert.ok(!text.includes("---"));
    // One fact per line, and money the way it is written in Brazil.
    assert.match(text, /R\$ \d/);
    assert.ok(text.split("\n").length > 4);

    // The bot records and informs; it never scolds and never advises.
    const judgemental = [
      "cuidado", "atenção", "reduza", "reduzir", "diminua", "corte", "cortar",
      "evite", "economize", "exagerou", "muito alto", "demais", "deveria",
      "melhor não", "pare de", "perigo", "alerta vermelho",
    ];
    const lowered = text.toLowerCase();
    for (const word of judgemental) {
      assert.ok(!lowered.includes(word), `the text judges the user: ${word}`);
    }
    assert.ok(!text.includes("!"), "no exclamation marks");
    db.close();
  });

  test("a closed month reports what happened instead of projecting", () => {
    const { db, userId } = fixture();
    dailyExpenses(db, userId, "2026-07-01", "2026-07-31", 5000);

    const f = forecast(db, userId, { month: "2026-07", asOf: "2026-08-10" });

    assert.equal(f.closed, true);
    assert.equal(f.days_remaining, 0);
    assert.equal(f.spent_cents, 155000);
    assert.equal(f.projected_total_cents, 155000);
    assert.equal(f.rate.basis, "closed");
    assert.equal(f.silent, true);
    assert.match(f.text, /mês fechado/);
    db.close();
  });
});

describe("the CLI", () => {
  function cli(args: string[]): { ok: boolean; exit: number; out: string } {
    const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return {
      ok: proc.status === 0,
      exit: proc.status ?? -1,
      out: proc.stdout ?? "",
    };
  }

  test("--json returns the ok:true contract", () => {
    const { db, path, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    db.close();

    const r = cli([
      "--db", path,
      "--user-id", String(userId),
      "--month", MONTH,
      "--as-of", "2026-08-10",
      "--json",
    ]);

    assert.equal(r.exit, 0);
    const body = JSON.parse(r.out);
    assert.equal(body.ok, true);
    assert.equal(body.month, MONTH);
    assert.equal(body.projected_total_cents, 310000);
    assert.equal(typeof body.text, "string");
    assert.equal(typeof body.silent, "boolean");
  });

  test("without --json it prints the text to send", () => {
    const { db, path, userId } = fixture();
    dailyExpenses(db, userId, "2026-08-01", "2026-08-10", 10000);
    db.close();

    const r = cli([
      "--db", path, "--user-id", String(userId),
      "--month", MONTH, "--as-of", "2026-08-10",
    ]);

    assert.equal(r.exit, 0);
    assert.match(r.out, /Previsão — agosto\/2026/);
    assert.ok(!r.out.startsWith("{"));
  });

  test("a bad call fails with Portuguese JSON and exit 1", () => {
    const { db, path } = fixture();
    db.close();

    const missing = cli(["--db", path]);
    assert.equal(missing.exit, 1);
    assert.equal(JSON.parse(missing.out).ok, false);
    assert.match(JSON.parse(missing.out).error, /Informe --user-id/);

    const unknown = cli(["--db", path, "--user-id", "999"]);
    assert.equal(unknown.exit, 1);
    assert.match(JSON.parse(unknown.out).error, /usuário/);

    const badMonth = cli(["--db", path, "--user-id", "1", "--month", "2026-13"]);
    assert.equal(badMonth.exit, 1);
    assert.match(JSON.parse(badMonth.out).error, /Mês inválido/);
  });
});
