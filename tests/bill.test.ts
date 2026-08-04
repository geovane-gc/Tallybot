/**
 * Tests for the credit-card statement module.
 *
 * The bugs worth catching here are the silent ones: a purchase landing on the
 * wrong statement is invisible until the bill arrives with a different number,
 * and a missing `user_id` filter is invisible until one person reads the other's
 * spending. So the boundary of the closing day, the clamping of day 31, the
 * month the due date falls in, and the isolation of two people who both named
 * their card "Nubank" all get their own test.
 *
 * Fixtures are built by running the real migrations from `db.ts` — never by
 * hand-writing a schema, which would drift the moment a migration is appended.
 *
 *     node --test tests/bill.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FinError,
  addDays,
  connect,
  migrate,
  now,
  resolveCategory,
  seedUser,
  type Db,
} from "../skills/finance/scripts/db.ts";

import {
  loadCard,
  openCardBills,
  resolveStatement,
  shiftStatement,
  statementForDate,
  statementForMonth,
  statementView,
  type CardCycleConfig,
} from "../skills/finance/scripts/bill.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "skills", "finance", "scripts", "bill.ts");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  db: Db;
  path: string;
}

/** An empty database with the real schema, from the real migrations. */
function newDb(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tally-bill-"));
  const path = join(dir, "tally.db");
  const db = connect(path);
  migrate(db);
  return { db, path };
}

/** A user with the seeded taxonomy, so category rollup is exercised for real. */
function addUser(db: Db, telegramId: string, name: string): number {
  const info = db
    .prepare(
      "INSERT INTO users (telegram_user_id, display_name, authenticated_at, " +
        "auth_epoch, created_at) VALUES (?, ?, ?, 0, ?)",
    )
    .run(telegramId, name, now(), now());
  const id = Number(info.lastInsertRowid);
  seedUser(db, id);
  return id;
}

function addCard(
  db: Db,
  userId: number,
  name: string,
  opts: { closing?: number | null; due?: number | null; limit?: number | null } = {},
): number {
  const info = db
    .prepare(
      "INSERT INTO accounts (user_id, name, type, institution, closing_day, due_day, " +
        "limit_cents, opening_balance_cents, created_at) " +
        "VALUES (?, ?, 'card', NULL, ?, ?, ?, 0, ?)",
    )
    .run(userId, name, opts.closing ?? null, opts.due ?? null, opts.limit ?? null, now());
  return Number(info.lastInsertRowid);
}

function addExpense(
  db: Db,
  userId: number,
  accountId: number,
  date: string,
  amountCents: number,
  description: string,
  opts: { category?: string; num?: number; total?: number; group?: string } = {},
): number {
  const categoryId = opts.category ? resolveCategory(db, userId, opts.category) : null;
  const info = db
    .prepare(
      "INSERT INTO transactions (user_id, type, amount_cents, description, date, " +
        "category_id, account_id, note, source, installment_num, installment_total, " +
        "installment_group, created_at, updated_at) " +
        "VALUES (?, 'expense', ?, ?, ?, ?, ?, NULL, 'test', ?, ?, ?, ?, ?)",
    )
    .run(
      userId,
      amountCents,
      description,
      date,
      categoryId,
      accountId,
      opts.num ?? null,
      opts.total ?? null,
      opts.group ?? null,
      now(),
      now(),
    );
  return Number(info.lastInsertRowid);
}

/** Closes the day-25 statement of the month, pays on the 5th of the next one. */
const CLOSES_25: CardCycleConfig = { closing_day: 25, due_day: 5 };

/* -------------------------------------------------------------------------- */
/* The closing-day boundary                                                   */
/* -------------------------------------------------------------------------- */

describe("closing-day boundary", () => {
  test("the day before the closing day stays on the statement that is closing", () => {
    assert.equal(statementForDate(CLOSES_25, "2026-07-24").month, "2026-07");
  });

  test("the closing day itself already belongs to the next statement", () => {
    // The documented convention: the statement closes during that day, so a
    // purchase made on it is billed a month later.
    assert.equal(statementForDate(CLOSES_25, "2026-07-25").month, "2026-08");
  });

  test("the day after the closing day is on the next statement", () => {
    assert.equal(statementForDate(CLOSES_25, "2026-07-26").month, "2026-08");
  });

  test("the roadmap's example: 28/07 on a card closing on the 25th bills in August", () => {
    assert.equal(statementForDate(CLOSES_25, "2026-07-28").month, "2026-08");
  });

  test("the cycle runs from the previous closing date to the day before this one", () => {
    const c = statementForMonth(CLOSES_25, "2026-08");
    assert.equal(c.start, "2026-07-25");
    assert.equal(c.end, "2026-08-24");
    assert.equal(c.closing_date, "2026-08-25");
    assert.equal(c.has_closing_day, true);
  });

  test("closing on the 1st makes the cycle the previous calendar month", () => {
    const c = statementForMonth({ closing_day: 1, due_day: 10 }, "2026-08");
    assert.equal(c.start, "2026-07-01");
    assert.equal(c.end, "2026-07-31");
  });

  test("consecutive statements are contiguous and never overlap", () => {
    for (const closing of [1, 5, 25, 28, 30, 31]) {
      const card = { closing_day: closing, due_day: 10 };
      for (let m = 2; m <= 12; m++) {
        const month = `2026-${String(m).padStart(2, "0")}`;
        const previous = `2026-${String(m - 1).padStart(2, "0")}`;
        const current = statementForMonth(card, month);
        const before = statementForMonth(card, previous);
        assert.equal(
          current.start,
          addDays(before.end, 1),
          `gap or overlap at ${month} with closing_day ${closing}`,
        );
        assert.ok(current.start <= current.end);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Clamping day 31                                                            */
/* -------------------------------------------------------------------------- */

describe("closing_day 31", () => {
  const card: CardCycleConfig = { closing_day: 31, due_day: 10 };

  test("February closes on the 28th", () => {
    assert.equal(statementForMonth(card, "2026-02").closing_date, "2026-02-28");
  });

  test("February closes on the 29th in a leap year", () => {
    assert.equal(statementForMonth(card, "2028-02").closing_date, "2028-02-29");
  });

  test("a 30-day month closes on the 30th", () => {
    assert.equal(statementForMonth(card, "2026-04").closing_date, "2026-04-30");
  });

  test("the last day of February is already the March statement", () => {
    assert.equal(statementForDate(card, "2026-02-27").month, "2026-02");
    assert.equal(statementForDate(card, "2026-02-28").month, "2026-03");
  });

  test("the last day of a 30-day month is already the next statement", () => {
    assert.equal(statementForDate(card, "2026-04-29").month, "2026-04");
    assert.equal(statementForDate(card, "2026-04-30").month, "2026-05");
  });

  test("the February statement starts on 31/01, not on 28/01", () => {
    // Computing the previous closing date as "one month before 28/02" would lose
    // 29, 30 and 31 January.
    const c = statementForMonth(card, "2026-02");
    assert.equal(c.start, "2026-01-31");
    assert.equal(c.end, "2026-02-27");
    assert.equal(statementForDate(card, "2026-01-31").month, "2026-02");
  });
});

/* -------------------------------------------------------------------------- */
/* Due dates                                                                  */
/* -------------------------------------------------------------------------- */

describe("due date", () => {
  test("due_day before closing_day pays in the following month", () => {
    assert.equal(statementForMonth(CLOSES_25, "2026-08").due_date, "2026-09-05");
  });

  test("due_day after closing_day pays in the closing month", () => {
    const c = statementForMonth({ closing_day: 5, due_day: 20 }, "2026-08");
    assert.equal(c.closing_date, "2026-08-05");
    assert.equal(c.due_date, "2026-08-20");
  });

  test("due_day equal to closing_day pays in the following month", () => {
    const c = statementForMonth({ closing_day: 10, due_day: 10 }, "2026-08");
    assert.equal(c.due_date, "2026-09-10");
  });

  test("the due day is clamped like the closing day", () => {
    const c = statementForMonth({ closing_day: 31, due_day: 31 }, "2026-01");
    assert.equal(c.closing_date, "2026-01-31");
    assert.equal(c.due_date, "2026-02-28");
  });

  test("the due date crosses the year with the statement", () => {
    assert.equal(statementForMonth(CLOSES_25, "2026-12").due_date, "2027-01-05");
  });

  test("no due_day configured leaves the due date null", () => {
    assert.equal(statementForMonth({ closing_day: 25, due_day: null }, "2026-08").due_date, null);
  });
});

/* -------------------------------------------------------------------------- */
/* Cards with no closing day                                                  */
/* -------------------------------------------------------------------------- */

describe("card with no closing day", () => {
  const card: CardCycleConfig = { closing_day: null, due_day: 10 };

  test("falls back to the calendar month instead of failing", () => {
    const c = statementForMonth(card, "2026-08");
    assert.equal(c.start, "2026-08-01");
    assert.equal(c.end, "2026-08-31");
    assert.equal(c.has_closing_day, false);
  });

  test("every date in the month is on that month's statement, the last day included", () => {
    assert.equal(statementForDate(card, "2026-08-01").month, "2026-08");
    assert.equal(statementForDate(card, "2026-08-31").month, "2026-08");
    assert.equal(statementForDate(card, "2026-09-01").month, "2026-09");
  });

  test("February is 28 days long, not 31", () => {
    assert.equal(statementForMonth(card, "2026-02").end, "2026-02-28");
  });

  test("the due date is still honoured, in the month after", () => {
    assert.equal(statementForMonth(card, "2026-08").due_date, "2026-09-10");
  });

  test("with neither closing nor due day there is no due date", () => {
    const c = statementForMonth({ closing_day: null, due_day: null }, "2026-08");
    assert.equal(c.due_date, null);
    assert.equal(c.has_closing_day, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Selecting a statement                                                      */
/* -------------------------------------------------------------------------- */

describe("selecting a statement", () => {
  test("the default is the open one, and it contains the reference date", () => {
    const c = resolveStatement(CLOSES_25, undefined, "2026-08-03");
    assert.equal(c.month, "2026-08");
    assert.ok(c.start <= "2026-08-03" && "2026-08-03" <= c.end);
  });

  test("`last` is the one that closed most recently", () => {
    const c = resolveStatement(CLOSES_25, "last", "2026-08-03");
    assert.equal(c.month, "2026-07");
    assert.ok(c.closing_date <= "2026-08-03");
    assert.ok(c.end < "2026-08-03");
  });

  test("`next` is the closed statement while its due date has not passed", () => {
    // On 03/08 the July statement (closed 25/07) comes due on 05/08.
    const c = resolveStatement(CLOSES_25, "next", "2026-08-03");
    assert.equal(c.month, "2026-07");
    assert.equal(c.due_date, "2026-08-05");
  });

  test("`next` moves to the open statement once the closed one has been billed", () => {
    const c = resolveStatement(CLOSES_25, "next", "2026-08-06");
    assert.equal(c.month, "2026-08");
    assert.equal(c.due_date, "2026-09-05");
  });

  test("`next` on a card with no due day falls back to the open statement", () => {
    const c = resolveStatement({ closing_day: 25, due_day: null }, "next", "2026-08-03");
    assert.equal(c.month, "2026-08");
  });

  test("an explicit YYYY-MM names the statement by closing month", () => {
    assert.equal(resolveStatement(CLOSES_25, "2026-03", "2026-08-03").month, "2026-03");
  });

  test("Portuguese selectors are accepted too", () => {
    assert.equal(resolveStatement(CLOSES_25, "aberta", "2026-08-03").month, "2026-08");
    assert.equal(resolveStatement(CLOSES_25, "fechada", "2026-08-03").month, "2026-07");
    assert.equal(resolveStatement(CLOSES_25, "próxima", "2026-08-03").month, "2026-07");
  });

  test("an unknown selector fails in Portuguese", () => {
    assert.throws(
      () => resolveStatement(CLOSES_25, "semana que vem", "2026-08-03"),
      (e: unknown) => e instanceof FinError && /fatura/i.test((e as Error).message),
    );
  });

  test("an impossible month fails in Portuguese", () => {
    assert.throws(
      () => statementForMonth(CLOSES_25, "2026-13"),
      (e: unknown) => e instanceof FinError && /YYYY-MM/.test((e as Error).message),
    );
  });

  test("a closing day outside 1..31 is refused instead of computing nonsense", () => {
    assert.throws(
      () => statementForMonth({ closing_day: 0, due_day: 5 }, "2026-08"),
      (e: unknown) => e instanceof FinError && /fechamento/.test((e as Error).message),
    );
  });

  test("shiftStatement walks backwards across the year", () => {
    const august = statementForMonth(CLOSES_25, "2026-01");
    assert.equal(shiftStatement(CLOSES_25, august, -1).month, "2025-12");
    assert.equal(shiftStatement(CLOSES_25, august, 1).month, "2026-02");
  });
});

/* -------------------------------------------------------------------------- */
/* The statement view                                                         */
/* -------------------------------------------------------------------------- */

describe("statement view", () => {
  test("only purchases inside the cycle are billed", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5 });

    addExpense(db, user, card, "2026-07-24", 1000, "Antes do fechamento");
    addExpense(db, user, card, "2026-07-25", 2000, "No dia do fechamento");
    addExpense(db, user, card, "2026-08-24", 3000, "Último dia do ciclo");
    addExpense(db, user, card, "2026-08-25", 4000, "Já é a próxima");

    const view = statementView(db, user, { statement: "2026-08" });
    assert.equal(view.statement.start, "2026-07-25");
    assert.equal(view.statement.end, "2026-08-24");
    assert.equal(view.total_cents, 5000);
    assert.equal(view.count, 2);
    assert.equal(view.total_fmt, "R$ 50,00");
    db.close();
  });

  test("the breakdown rolls up to the root category", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5 });

    addExpense(db, user, card, "2026-08-01", 5000, "iFood", { category: "Delivery" });
    addExpense(db, user, card, "2026-08-02", 3000, "Mercado", { category: "Mercado" });
    addExpense(db, user, card, "2026-08-03", 2000, "Uber", { category: "Uber/99" });

    const view = statementView(db, user, { statement: "2026-08" });
    const names = view.by_category.map((c) => c.category);
    assert.deepEqual(names, ["Alimentação", "Transporte"]);
    assert.equal(view.by_category[0].total_cents, 8000);
    assert.equal(view.by_category[0].count, 2);
    assert.equal(view.by_category[0].pct, 80);
    db.close();
  });

  test("an instalment plan lands one instalment per statement", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5 });

    // Bought on 28/07: the first instalment is already on the August statement.
    const dates = ["2026-07-28", "2026-08-28", "2026-09-28"];
    dates.forEach((date, i) => {
      addExpense(db, user, card, date, 10000, "Geladeira", {
        category: "Casa",
        num: i + 1,
        total: 3,
        group: "geladeira-1",
      });
    });

    for (const [month, expected] of [
      ["2026-08", "1/3"],
      ["2026-09", "2/3"],
      ["2026-10", "3/3"],
    ] as const) {
      const view = statementView(db, user, { statement: month });
      assert.equal(view.installments.length, 1, `${month} should carry one instalment`);
      assert.equal(view.installments[0].installment, expected);
      assert.equal(view.total_cents, 10000);
      assert.match(view.text, /Parcelas nesta fatura/);
      assert.ok(view.text.includes(`Geladeira ${expected}`));
    }
    db.close();
  });

  test("the limit usage and the comparison with the previous statement", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5, limit: 100000 });

    addExpense(db, user, card, "2026-07-01", 20000, "Julho");
    addExpense(db, user, card, "2026-08-01", 25000, "Agosto");

    const view = statementView(db, user, { statement: "2026-08" });
    assert.equal(view.total_cents, 25000);
    assert.equal(view.limit?.used_pct, 25);
    assert.equal(view.limit?.remaining_fmt, "R$ 750,00");
    assert.equal(view.previous.month, "2026-07");
    assert.equal(view.previous.total_cents, 20000);
    assert.equal(view.previous.change_pct, 25);
    assert.equal(view.previous.difference_fmt, "R$ 50,00");
    assert.match(view.text, /25% acima da fatura de 07\/2026/);
    assert.match(view.text, /Limite: R\$ 1\.000,00/);
    db.close();
  });

  test("no limit configured leaves the limit block out", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    addCard(db, user, "Nubank", { closing: 25, due: 5 });
    const view = statementView(db, user, { statement: "2026-08" });
    assert.equal(view.limit, null);
    assert.ok(!view.text.includes("Limite"));
    db.close();
  });

  test("the open statement is the default", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5 });
    addExpense(db, user, card, "2026-07-28", 4200, "Compra");

    const view = statementView(db, user, { reference: "2026-08-03" });
    assert.equal(view.statement.month, "2026-08");
    assert.equal(view.total_cents, 4200);
    db.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Two people, one database                                                   */
/* -------------------------------------------------------------------------- */

describe("isolation between the two users", () => {
  function shared() {
    const fixture = newDb();
    const { db } = fixture;
    const a = addUser(db, "111111111", "Geovane");
    const b = addUser(db, "222222222", "Namorada");
    // Same card name on purpose: UNIQUE is (user_id, name), so both exist, and a
    // query missing its user_id filter would mix the two.
    const cardA = addCard(db, a, "Nubank", { closing: 25, due: 5, limit: 100000 });
    const cardB = addCard(db, b, "Nubank", { closing: 10, due: 20, limit: 500000 });

    addExpense(db, a, cardA, "2026-08-01", 11100, "Dela? não, dele");
    addExpense(db, b, cardB, "2026-08-01", 22200, "Dele? não, dela");
    return { fixture, db, a, b, cardA, cardB };
  }

  test("each statement holds only its own owner's purchases", () => {
    const { db, a, b } = shared();

    const viewA = statementView(db, a, { account: "Nubank", statement: "2026-08" });
    assert.equal(viewA.total_cents, 11100);
    assert.equal(viewA.count, 1);
    assert.equal(viewA.statement.closing_date, "2026-08-25");

    const viewB = statementView(db, b, { account: "Nubank", statement: "2026-08" });
    assert.equal(viewB.total_cents, 22200);
    assert.equal(viewB.count, 1);
    // B's own cycle, from B's own closing day.
    assert.equal(viewB.statement.closing_date, "2026-08-10");
    assert.equal(viewB.statement.due_date, "2026-08-20");

    assert.ok(!viewA.text.includes("222"));
    assert.ok(!viewB.text.includes("111"));
    db.close();
  });

  test("each user resolves their own card, with their own limit", () => {
    const { db, a, b, cardA, cardB } = shared();
    assert.equal(loadCard(db, a, "Nubank").id, cardA);
    assert.equal(loadCard(db, b, "Nubank").id, cardB);
    assert.equal(loadCard(db, a).limit_cents, 100000);
    assert.equal(loadCard(db, b).limit_cents, 500000);
    db.close();
  });

  test("the other person's card is simply not found", () => {
    const { db, a, b } = shared();
    addCard(db, b, "Cartão secreto da namorada", { closing: 15 });
    assert.throws(
      () => loadCard(db, a, "Cartão secreto da namorada"),
      (e: unknown) => e instanceof FinError && /não achei o cartão/i.test((e as Error).message),
    );
    // And it is still there for its owner.
    assert.equal(loadCard(db, b, "Cartão secreto da namorada").closing_day, 15);
    db.close();
  });

  test("the overview lists only the caller's cards", () => {
    const { db, a, b } = shared();
    const overviewA = openCardBills(db, a, "2026-08-03");
    assert.deepEqual(
      overviewA.cards.map((c) => c.total_cents),
      [11100],
    );
    assert.equal(overviewA.total_cents, 11100);

    const overviewB = openCardBills(db, b, "2026-08-03");
    assert.equal(overviewB.cards.length, 1);
    assert.equal(overviewB.total_cents, 22200);
    db.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The overview                                                               */
/* -------------------------------------------------------------------------- */

describe("open bills across cards", () => {
  test("every card is listed, soonest due first, with the total", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const nubank = addCard(db, user, "Nubank", { closing: 25, due: 5 });
    const itau = addCard(db, user, "Itaú", { closing: 10, due: 20 });
    addCard(db, user, "Sem uso", { closing: 1, due: 15 });

    addExpense(db, user, nubank, "2026-07-28", 30000, "Tênis");
    addExpense(db, user, itau, "2026-08-01", 12000, "Mercado");

    const overview = openCardBills(db, user, "2026-08-03");
    assert.equal(overview.cards.length, 3);
    // On 03/08: Itaú's open statement closes 10/08 and is due 20/08; Nubank's
    // closes 25/08 and is due 05/09; "Sem uso" closed on 01/08, so its open
    // statement is September's — due 15/09, the furthest away of the three.
    assert.deepEqual(
      overview.cards.map((c) => c.account),
      ["Itaú", "Nubank", "Sem uso"],
    );
    assert.deepEqual(
      overview.cards.map((c) => c.due_date),
      ["2026-08-20", "2026-09-05", "2026-09-15"],
    );
    assert.equal(overview.total_cents, 42000);
    assert.equal(overview.total_fmt, "R$ 420,00");
    assert.match(overview.text, /Faturas em aberto/);
    assert.match(overview.text, /Total nos cartões: \*R\$ 420,00\*/);
    db.close();
  });

  test("a card with no purchases is listed at zero rather than omitted", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    addCard(db, user, "Nubank", { closing: 25, due: 5 });
    const overview = openCardBills(db, user, "2026-08-03");
    assert.equal(overview.cards.length, 1);
    assert.equal(overview.cards[0].total_cents, 0);
    assert.equal(overview.cards[0].total_fmt, "R$ 0,00");
    db.close();
  });

  test("no cards at all still produces readable Portuguese", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const overview = openCardBills(db, user, "2026-08-03");
    assert.deepEqual(overview.cards, []);
    assert.match(overview.text, /nenhum cartão/i);
    db.close();
  });

  test("checking accounts are not cards and never show up", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    // seedUser already created "Carteira" (cash).
    const overview = openCardBills(db, user, "2026-08-03");
    assert.deepEqual(overview.cards, []);
    assert.throws(
      () => statementView(db, user, { account: "Carteira" }),
      (e: unknown) =>
        e instanceof FinError && /não é um cartão de crédito/.test((e as Error).message),
    );
    db.close();
  });

  test("with several cards and no name, it asks instead of guessing", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    addCard(db, user, "Nubank", { closing: 25, due: 5 });
    addCard(db, user, "Itaú", { closing: 10, due: 20 });
    assert.throws(
      () => statementView(db, user, {}),
      (e: unknown) => e instanceof FinError && /mais de um cartão/i.test((e as Error).message),
    );
    db.close();
  });

  test("with no card at all it says so instead of throwing something technical", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    db.prepare("UPDATE accounts SET active = 0 WHERE user_id = ?").run(user);
    assert.throws(
      () => statementView(db, user, {}),
      (e: unknown) => e instanceof FinError && /cartão de crédito/.test((e as Error).message),
    );
    db.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The Portuguese text                                                        */
/* -------------------------------------------------------------------------- */

describe("the text sent to Telegram", () => {
  /** Telegram renders no tables: no pipe-delimited rows, no `---|---` rules. */
  function assertNoMarkdownTable(text: string) {
    for (const line of text.split("\n")) {
      assert.ok(!line.includes("|"), `pipe in line: ${line}`);
      assert.ok(!/^\s*:?-{3,}/.test(line), `horizontal rule in line: ${line}`);
    }
  }

  test("a statement with purchases reads as Portuguese prose, one fact per line", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5, limit: 500000 });
    addExpense(db, user, card, "2026-08-01", 15000, "iFood", { category: "Delivery" });
    addExpense(db, user, card, "2026-08-02", 5000, "Uber", { category: "Uber/99" });

    const { text } = statementView(db, user, { statement: "2026-08" });
    assertNoMarkdownTable(text);
    assert.match(text, /^💳 \*Nubank — fatura de 08\/2026\*/);
    assert.match(text, /Total: \*R\$ 200,00\*/);
    assert.match(text, /2 compras/);
    assert.match(text, /Alimentação — R\$ 150,00 \(75%\)/);
    assert.match(text, /Onde o dinheiro foi/);
    db.close();
  });

  test("an empty statement says so, keeping the cycle and the dates", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    addCard(db, user, "Nubank", { closing: 25, due: 5 });

    const { text, count, total_fmt } = statementView(db, user, { statement: "2026-08" });
    assert.equal(count, 0);
    assert.equal(total_fmt, "R$ 0,00");
    assertNoMarkdownTable(text);
    assert.match(text, /Nenhuma compra nessa fatura/);
    assert.match(text, /fatura de 08\/2026/);
    assert.ok(text.split("\n").every((l) => l.trim() !== "" || true));
    assert.ok(text.length > 40, "an empty statement still has to say something useful");
    assert.ok(!text.includes("undefined") && !text.includes("NaN"));
    db.close();
  });

  test("a card with no closing day warns that the cycle is a guess", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: null, due: 10 });
    addExpense(db, user, card, "2026-08-31", 7700, "Compra do último dia");

    const view = statementView(db, user, { statement: "2026-08" });
    assert.equal(view.statement.has_closing_day, false);
    assert.equal(view.total_cents, 7700);
    assertNoMarkdownTable(view.text);
    assert.match(view.text, /não tem dia de fechamento cadastrado/);
    assert.match(view.text, /mês civil/);
    db.close();
  });

  test("the overview text is table-free too", () => {
    const { db } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5 });
    addExpense(db, user, card, "2026-08-01", 100, "Café");
    assertNoMarkdownTable(openCardBills(db, user, "2026-08-03").text);
    db.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The CLI                                                                    */
/* -------------------------------------------------------------------------- */

describe("CLI", () => {
  function cli(args: string[]): { stdout: string; status: number } {
    const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.ok(proc.stdout !== undefined, `no output. stderr: ${proc.stderr}`);
    return { stdout: proc.stdout, status: proc.status ?? -1 };
  }

  function withCard(): { path: string; user: number } {
    const { db, path } = newDb();
    const user = addUser(db, "111111111", "Geovane");
    const card = addCard(db, user, "Nubank", { closing: 25, due: 5, limit: 100000 });
    addExpense(db, user, card, "2026-07-28", 30000, "Tênis", { category: "Roupas" });
    db.close();
    return { path, user };
  }

  test("--json prints the {ok: true, ...} envelope and exits 0", () => {
    const { path, user } = withCard();
    const r = cli([
      "--db", path,
      "--user-id", String(user),
      "--statement", "2026-08",
      "--json",
    ]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.total_fmt, "R$ 300,00");
    assert.equal(body.statement.month, "2026-08");
    assert.equal(body.account.name, "Nubank");
  });

  test("without --json it prints just the Portuguese text", () => {
    const { path, user } = withCard();
    const r = cli(["--db", path, "--user-id", String(user), "--statement", "2026-08"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^💳 \*Nubank — fatura de 08\/2026\*/);
    assert.ok(!r.stdout.trimStart().startsWith("{"));
  });

  test("--all answers 'quanto devo nos cartões?'", () => {
    const { path, user } = withCard();
    const r = cli(["--db", path, "--user-id", String(user), "--all", "--json"]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.cards.length, 1);
    assert.equal(body.cards[0].account, "Nubank");
  });

  test("a missing --user-id fails with JSON and exit 1", () => {
    const { path } = withCard();
    const r = cli(["--db", path, "--statement", "2026-08", "--json"]);
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /--user-id/);
  });

  test("a Telegram id passed as --user-id is rejected as an unknown user", () => {
    const { path } = withCard();
    const r = cli(["--db", path, "--user-id", "111111111", "--json"]);
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /Usuário não encontrado/);
  });

  test("a non-integer --user-id is refused", () => {
    const { path } = withCard();
    const r = cli(["--db", path, "--user-id", "abc"]);
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /inteiro/);
  });

  test("an unknown statement selector fails in Portuguese, as JSON", () => {
    const { path, user } = withCard();
    const r = cli(["--db", path, "--user-id", String(user), "--statement", "amanhã"]);
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /Use aberta, fechada, proxima ou YYYY-MM/);
  });

  test("an unknown option is explained rather than crashing", () => {
    const { path, user } = withCard();
    const r = cli(["--db", path, "--user-id", String(user), "--periodo", "mes"]);
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /Opções aceitas/);
  });

  test("--help prints the usage and exits 0", () => {
    const r = cli(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--statement/);
  });
});
