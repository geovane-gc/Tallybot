#!/usr/bin/env node
/**
 * End-of-month forecast: where the current month lands, and the same per budget.
 *
 *     node forecast.ts --db PATH --user-id <users.id> [--month YYYY-MM] [--json]
 *
 * `--user-id` is the internal `users.id`, never a Telegram id. Identity and
 * authentication live in `fin.ts`; this module assumes the caller already
 * resolved and authorised the user. What it does own is isolation: **every SQL
 * statement here filters `user_id`**, with no exception, because two people share
 * this database and a missing filter is somebody else's ledger leaking into a
 * projection.
 *
 * The projection is deliberately built from four parts that are returned
 * separately, so the Portuguese text can explain itself instead of producing one
 * magic number:
 *
 *   1. `spent_cents`         — what is already in the ledger this month. Actual.
 *   2. `variable_estimate`   — a daily rate times the days left. The only guess.
 *   3. `fixed_pending_cents` — recurring expenses that will still be posted this
 *                              month, from `recurring` (never double-counting one
 *                              that was already generated).
 *   4. `scheduled_cents`     — expenses already sitting in `transactions` with a
 *                              date later this month (instalments, mostly). Real
 *                              amounts on known dates, so they are certain, not
 *                              estimated, and they are kept out of (2).
 *
 * ## The daily rate, which is the whole craft of this feature
 *
 * - **Fixed costs are excluded from the rate.** The sample skips anything with a
 *   `recurring_id` (it is already covered by part 3 or by `spent`) and anything
 *   with an `installment_total` (covered by part 4, or already posted). Leaving
 *   rent in the sample would project a rent-sized charge onto every remaining day
 *   *and* count it again in part 3 — the double count that makes a forecast
 *   embarrassing.
 *
 * - **This month alone is noisy.** One R$ 2.000 purchase on the 2nd, extrapolated
 *   over 29 days, "projects" a catastrophe that will not happen. So the rate is a
 *   blend of this month's rate and the same person's previous months, weighted by
 *   how far into the month we are: `w = days_elapsed / days_in_month`. On the 2nd
 *   the projection is mostly history; on the 28th it is mostly this month. The
 *   history side takes up to three previous calendar months, weighted 3/2/1 from
 *   most to least recent, skipping months with no variable expense at all — in a
 *   manually-fed ledger an empty month means "the bot was not in use", not "spent
 *   nothing", and averaging a zero in there would depress every forecast.
 *   A history month's denominator starts at the person's first transaction ever,
 *   so the month they signed up on the 20th counts 11 days, not 30.
 *
 * - **Weekends: corrected, but only with enough data.** Spending is not flat
 *   across the week, and the remaining days of a month are not a proportional mix
 *   (on the 25th, "6 days left" can mean two weekend days out of six). So the
 *   sample is split into weekend and weekday averages and each remaining day is
 *   weighted by its own factor, renormalised so a full month still sums to the
 *   same total. It only kicks in with at least 8 weekend and 12 weekday days
 *   sampled, and each factor is clamped to [0.5, 2] — below that the correction
 *   would be fitting noise, which is worse than not correcting at all.
 *
 * - **Paydays are deliberately not modelled.** The obvious effect (people spend
 *   more right after being paid) needs a reliable salary date, and this ledger
 *   only has whatever income was typed in, whenever it was typed. Inferring a
 *   payday from two or three `income` rows would add a swing to the projection
 *   with nothing solid underneath it. The month-elapsed weighting already absorbs
 *   part of it: by mid-month the sample contains the payday spike.
 *
 * - **Too little history says so.** With no usable previous month and fewer than
 *   7 days elapsed, there is no rate: `variable_estimate_cents` comes back `null`,
 *   `confidence` is `"none"`, and the text says it does not know yet. A forecast
 *   that admits ignorance is more useful than a confident wrong number.
 *
 * Language split, as everywhere in this codebase: identifiers, comments and JSON
 * keys English; anything the user reads — `text`, labels, `FinError` messages —
 * Portuguese. Money always through `formatMoney`.
 */

import { parseArgs } from "node:util";

import {
  CURRENT_SCHEMA_VERSION,
  FinError,
  addDays,
  addMonths,
  categoryAndChildrenIds,
  connect,
  currentVersion,
  formatMoney,
  fullCategoryName,
  isValidMonth,
  lastDayOfMonth,
  migrate,
  monthOf,
  periodRange,
  today,
  type BudgetStatus,
  type Db,
} from "./db.ts";

type Args = Record<string, string | boolean | undefined>;
type Output = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Tuning constants — the model's assumptions, in one place                    */
/* -------------------------------------------------------------------------- */

/** Days of the current month needed to trust it on its own, with no history. */
const MIN_DAYS_FOR_SELF_RATE = 7;

/** How many previous calendar months may feed the rate. */
const HISTORY_MONTHS = 3;

/** Weight of each usable history month, most recent first. */
const HISTORY_WEIGHTS = [3, 2, 1];

/** Below these sample sizes the weekend correction is noise, so it is skipped. */
const MIN_WEEKEND_DAYS = 8;
const MIN_WEEKDAY_DAYS = 12;

/** A weekend day never counts as less than half or more than double a weekday. */
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2;

/** Safety valve for the date walks; a month never needs more than 31. */
const MAX_WALK = 2000;

const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/* -------------------------------------------------------------------------- */
/* Small date helpers (calendar arithmetic itself lives in db.ts)              */
/* -------------------------------------------------------------------------- */

const dayOfMonth = (iso: string): number => Number(iso.slice(8, 10));

function isWeekend(iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Every date from `start` to `end`, inclusive. Empty when `start > end`. */
function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = start;
  for (let i = 0; cursor <= end && i < MAX_WALK; i++) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** `2026-08` -> `agosto/2026`, for the text. */
function monthLabel(month: string): string {
  const [year, mm] = month.split("-").map(Number);
  return `${MONTHS_PT[mm - 1]}/${year}`;
}

/** `2026-08-22` -> `22/08`, matching the short dates in `fin.ts` reports. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

/* -------------------------------------------------------------------------- */
/* Reads — every one of them scoped by user_id                                */
/* -------------------------------------------------------------------------- */

/** `category_id IN (…)` fragment plus its parameters, or nothing. */
function categoryClause(categoryIds?: number[] | null): { sql: string; params: number[] } {
  if (!categoryIds || categoryIds.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND category_id IN (${categoryIds.map(() => "?").join(",")})`,
    params: categoryIds,
  };
}

function scalar(db: Db, sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>;
  const first = row ? Object.values(row)[0] : 0;
  return Number(first ?? 0);
}

/** Expenses in a window, whatever their origin. */
function expenseTotal(
  db: Db,
  userId: number,
  start: string,
  end: string,
  categoryIds?: number[] | null,
): number {
  if (start > end) return 0;
  const cat = categoryClause(categoryIds);
  return scalar(
    db,
    "SELECT SUM(amount_cents) FROM transactions " +
      "WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?" +
      cat.sql,
    [userId, start, end, ...cat.params],
  );
}

/** Expenses in a window, per date. Used for the day-by-day crossing walk. */
function expensesByDate(
  db: Db,
  userId: number,
  start: string,
  end: string,
  categoryIds?: number[] | null,
): Map<string, number> {
  const map = new Map<string, number>();
  if (start > end) return map;
  const cat = categoryClause(categoryIds);
  const rows = db
    .prepare(
      "SELECT date, SUM(amount_cents) AS total FROM transactions " +
        "WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?" +
        cat.sql +
        " GROUP BY date",
    )
    .all(...([userId, start, end, ...cat.params] as never[])) as {
    date: string;
    total: number;
  }[];
  for (const r of rows) map.set(r.date, Number(r.total));
  return map;
}

/**
 * Variable expenses per date — the rate's raw material.
 *
 * `recurring_id IS NULL` and `installment_total IS NULL` are the exclusions that
 * keep parts 3 and 4 of the projection from being counted twice, once as
 * themselves and once inside the daily rate.
 */
function variableByDate(
  db: Db,
  userId: number,
  start: string,
  end: string,
  categoryIds?: number[] | null,
): Map<string, number> {
  const map = new Map<string, number>();
  if (start > end) return map;
  const cat = categoryClause(categoryIds);
  const rows = db
    .prepare(
      "SELECT date, SUM(amount_cents) AS total FROM transactions " +
        "WHERE user_id = ? AND type = 'expense' AND recurring_id IS NULL " +
        "AND installment_total IS NULL AND date BETWEEN ? AND ?" +
        cat.sql +
        " GROUP BY date",
    )
    .all(...([userId, start, end, ...cat.params] as never[])) as {
    date: string;
    total: number;
  }[];
  for (const r of rows) map.set(r.date, Number(r.total));
  return map;
}

/** The person's first transaction ever, to keep history denominators honest. */
function firstActivity(db: Db, userId: number): string | null {
  const row = db
    .prepare("SELECT MIN(date) AS first FROM transactions WHERE user_id = ?")
    .get(userId) as { first: string | null } | undefined;
  return row?.first ?? null;
}

/* -------------------------------------------------------------------------- */
/* Fixed costs still to be posted                                             */
/* -------------------------------------------------------------------------- */

interface RecurringRow {
  id: number;
  description: string;
  amount_cents: number;
  category_id: number | null;
  frequency: string;
  day: number;
  next_date: string;
  ends_on: string | null;
}

export interface PendingFixed {
  recurring_id: number;
  description: string;
  date: string;
  amount_cents: number;
  amount_fmt: string;
  category_id: number | null;
  /** Due on or before `as_of` and still not in the ledger: `recurring apply` owes it. */
  overdue: boolean;
}

/**
 * The dates a recurring entry falls on inside `[start, end]`.
 *
 * `next_date` is the anchor — it is what `recurring apply` advances — and
 * `frequency`, `day` and `ends_on` shape the rest:
 *
 * - monthly: at most one occurrence, on `day` clamped to the month's length, and
 *   only from `next_date`'s month onwards.
 * - weekly: the `next_date` chain, every 7 days.
 * - yearly: the anniversary of `next_date`, when the month matches.
 */
function occurrencesInWindow(r: RecurringRow, start: string, end: string): string[] {
  const dates: string[] = [];
  const withinEnd = (iso: string) => !r.ends_on || iso <= r.ends_on;

  if (r.frequency === "weekly") {
    let cursor = r.next_date;
    for (let i = 0; cursor < start && i < MAX_WALK; i++) cursor = addDays(cursor, 7);
    for (let i = 0; cursor <= end && i < MAX_WALK; i++) {
      if (withinEnd(cursor)) dates.push(cursor);
      cursor = addDays(cursor, 7);
    }
    return dates;
  }

  const month = monthOf(start);
  const [year, mm] = month.split("-").map(Number);
  const last = lastDayOfMonth(year, mm);

  if (r.frequency === "yearly") {
    // The anniversary keeps `next_date`'s month and day; only the year moves.
    if (r.next_date.slice(5, 7) !== month.slice(5, 7)) return dates;
    if (month < monthOf(r.next_date)) return dates;
    const day = Math.min(dayOfMonth(r.next_date), last);
    const occ = `${month}-${String(day).padStart(2, "0")}`;
    if (occ >= start && occ <= end && withinEnd(occ)) dates.push(occ);
    return dates;
  }

  // monthly (the schema's default, and everything that is not weekly/yearly)
  if (month < monthOf(r.next_date)) return dates;
  const day = Math.min(Math.max(1, r.day || dayOfMonth(r.next_date)), last);
  const occ = `${month}-${String(day).padStart(2, "0")}`;
  if (occ >= start && occ <= end && withinEnd(occ)) dates.push(occ);
  return dates;
}

/**
 * Recurring expenses that will still be posted inside this month.
 *
 * The `transactions` lookup per (recurring_id, date) is the anti-double-count: an
 * occurrence `recurring apply` already generated is spending, not a projection,
 * and it is already inside `spent_cents` or `scheduled_cents`.
 */
function pendingFixed(
  db: Db,
  userId: number,
  monthStart: string,
  monthEnd: string,
  asOf: string,
): PendingFixed[] {
  const rows = db
    .prepare(
      "SELECT id, description, amount_cents, category_id, frequency, day, next_date, ends_on " +
        "FROM recurring WHERE user_id = ? AND active = 1 AND type = 'expense'",
    )
    .all(userId) as RecurringRow[];

  const posted = db.prepare(
    "SELECT 1 FROM transactions WHERE user_id = ? AND recurring_id = ? AND date = ?",
  );

  const out: PendingFixed[] = [];
  for (const r of rows) {
    for (const date of occurrencesInWindow(r, monthStart, monthEnd)) {
      if (posted.get(userId, r.id, date)) continue;
      out.push({
        recurring_id: r.id,
        description: r.description,
        date,
        amount_cents: Number(r.amount_cents),
        amount_fmt: formatMoney(Number(r.amount_cents)),
        category_id: r.category_id,
        overdue: date <= asOf,
      });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/* -------------------------------------------------------------------------- */
/* The daily rate                                                             */
/* -------------------------------------------------------------------------- */

export type RateBasis = "closed" | "insufficient" | "current" | "history" | "blend";

interface SampleWindow {
  month: string;
  start: string;
  end: string;
  days: number;
}

interface RateContext {
  /** This month up to `as_of`, or null when nothing of it has elapsed. */
  current: SampleWindow | null;
  /** Previous calendar months, most recent first, already clamped to first activity. */
  history: SampleWindow[];
  daysInMonth: number;
  elapsed: number;
}

interface Rate {
  basis: RateBasis;
  /** Cents per day, unrounded. `null` when there is not enough to go on. */
  centsPerDay: number | null;
  current: number | null;
  history: number | null;
  weightCurrent: number;
  months: string[];
  historyDays: number;
}

function totalIn(samples: Map<string, number>, w: SampleWindow): number {
  let total = 0;
  for (const [date, cents] of samples) {
    if (date >= w.start && date <= w.end) total += cents;
  }
  return total;
}

/**
 * The rate for one scope: the whole ledger, or one budget's categories.
 *
 * `samples` must already be the variable-only per-date map for that scope,
 * covering every window in `ctx`.
 */
function computeRate(samples: Map<string, number>, ctx: RateContext): Rate {
  const currentTotal = ctx.current ? totalIn(samples, ctx.current) : 0;
  const currentRate = ctx.current && ctx.elapsed > 0 ? currentTotal / ctx.elapsed : null;

  // A history month with nothing in it is treated as "the bot was not in use",
  // not as a month of zero spending.
  const usable = ctx.history
    .map((w) => ({ window: w, total: totalIn(samples, w) }))
    .filter((h) => h.total > 0);

  let historyRate: number | null = null;
  let historyDays = 0;
  if (usable.length) {
    let weighted = 0;
    let weights = 0;
    usable.forEach((h, index) => {
      const weight = HISTORY_WEIGHTS[index] ?? 1;
      weighted += weight * (h.total / h.window.days);
      weights += weight;
      historyDays += h.window.days;
    });
    historyRate = weighted / weights;
  }

  const months = usable.map((h) => h.window.month);

  if (historyRate === null) {
    if (currentRate === null || ctx.elapsed < MIN_DAYS_FOR_SELF_RATE) {
      return {
        basis: "insufficient",
        centsPerDay: null,
        current: currentRate,
        history: null,
        // No model, so no weights: reporting one would imply a rate that is not
        // being returned.
        weightCurrent: 0,
        months,
        historyDays: 0,
      };
    }
    return {
      basis: "current",
      centsPerDay: currentRate,
      current: currentRate,
      history: null,
      weightCurrent: 1,
      months,
      historyDays: 0,
    };
  }

  if (currentRate === null) {
    // A month that has not started yet: history is all there is.
    return {
      basis: "history",
      centsPerDay: historyRate,
      current: null,
      history: historyRate,
      weightCurrent: 0,
      months,
      historyDays,
    };
  }

  const weight = Math.min(1, ctx.elapsed / ctx.daysInMonth);
  return {
    basis: "blend",
    centsPerDay: weight * currentRate + (1 - weight) * historyRate,
    current: currentRate,
    history: historyRate,
    weightCurrent: weight,
    months,
    historyDays,
  };
}

/* -------------------------------------------------------------------------- */
/* Weekend profile                                                            */
/* -------------------------------------------------------------------------- */

interface DayProfile {
  weekend: number;
  weekday: number;
  adjusted: boolean;
}

const FLAT_PROFILE: DayProfile = { weekend: 1, weekday: 1, adjusted: false };

/**
 * How much a weekend day costs relative to a weekday, from the pooled sample.
 *
 * Renormalised so that applying the factors over the sampled days reproduces the
 * sampled total: the correction redistributes the projection across the remaining
 * days, it never inflates it.
 */
function dayProfile(samples: Map<string, number>, windows: SampleWindow[]): DayProfile {
  let weekendSum = 0;
  let weekdaySum = 0;
  let weekendDays = 0;
  let weekdayDays = 0;

  for (const w of windows) {
    for (const date of datesBetween(w.start, w.end)) {
      const value = samples.get(date) ?? 0;
      if (isWeekend(date)) {
        weekendSum += value;
        weekendDays++;
      } else {
        weekdaySum += value;
        weekdayDays++;
      }
    }
  }

  const days = weekendDays + weekdayDays;
  const total = weekendSum + weekdaySum;
  if (
    days === 0 ||
    total <= 0 ||
    weekendDays < MIN_WEEKEND_DAYS ||
    weekdayDays < MIN_WEEKDAY_DAYS
  ) {
    return FLAT_PROFILE;
  }

  const overall = total / days;
  const clamp = (x: number) => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, x));
  let weekend = clamp(weekendSum / weekendDays / overall);
  let weekday = clamp(weekdaySum / weekdayDays / overall);

  const norm = days / (weekendDays * weekend + weekdayDays * weekday);
  weekend *= norm;
  weekday *= norm;

  return { weekend, weekday, adjusted: true };
}

const dayWeight = (date: string, profile: DayProfile): number =>
  isWeekend(date) ? profile.weekend : profile.weekday;

/* -------------------------------------------------------------------------- */
/* The forecast                                                               */
/* -------------------------------------------------------------------------- */

export type Confidence = "none" | "low" | "medium" | "high";

export interface BudgetForecast {
  category_id: number | null;
  category: string;
  month_specific: boolean;
  limit_cents: number;
  limit_fmt: string;
  spent_cents: number;
  spent_fmt: string;
  fixed_pending_cents: number;
  scheduled_cents: number;
  estimated_cents: number;
  projected_cents: number;
  projected_fmt: string;
  projected_pct: number;
  alert_pct: number;
  /** Where the *projection* lands, on `fin.ts`'s ok/warning/over scale. */
  status: BudgetStatus;
  /** Where the money actually stands today. */
  current_status: BudgetStatus;
  over_projected: boolean;
  overflow_cents: number;
  overflow_fmt: string;
  /** Already past the limit before any projection. */
  already_over: boolean;
  /** The day the limit is crossed at the current rate, or null. */
  crossing_date: string | null;
  crossing_day: number | null;
}

export interface Forecast extends Output {
  month: string;
  month_label: string;
  as_of: string;
  closed: boolean;
  days_in_month: number;
  days_elapsed: number;
  days_remaining: number;

  spent_cents: number;
  spent_fmt: string;
  fixed_pending_cents: number;
  fixed_pending_fmt: string;
  fixed_pending: PendingFixed[];
  scheduled_cents: number;
  scheduled_fmt: string;
  scheduled_count: number;
  /** The estimated part. `null` when there is not enough history to project. */
  variable_estimate_cents: number | null;
  variable_estimate_fmt: string | null;

  projected_total_cents: number;
  projected_total_fmt: string;
  certain_cents: number;
  certain_fmt: string;
  estimated_cents: number;
  estimated_fmt: string;
  /** Share of the projection that is not a guess, 0-100. */
  certain_pct: number;

  rate: {
    basis: RateBasis;
    cents_per_day: number | null;
    cents_per_day_fmt: string | null;
    current_cents_per_day: number | null;
    history_cents_per_day: number | null;
    weight_current: number;
    history_months: string[];
    history_days: number;
    observed_days: number;
    weekend_adjusted: boolean;
    weekend_factor: number;
    weekday_factor: number;
  };
  confidence: Confidence;
  confidence_label: string;

  budgets: BudgetForecast[];
  text: string;
  silent: boolean;
}

export interface ForecastOptions {
  /** `YYYY-MM`. Defaults to the month of `asOf`. */
  month?: string;
  /** The day the forecast is made on. Defaults to today in São Paulo. */
  asOf?: string;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: "insuficiente",
  low: "baixa",
  medium: "média",
  high: "alta",
};

interface BudgetRow {
  category_id: number | null;
  month: string | null;
  limit_cents: number;
  alert_pct: number;
}

function statusOf(pct: number, alertPct: number): BudgetStatus {
  return pct >= 100 ? "over" : pct >= alertPct ? "warning" : "ok";
}

/**
 * Projects the month for one user.
 *
 * Pure read: it never writes. The caller is responsible for having authenticated
 * `userId` — see the module header.
 */
export function forecast(
  db: Db,
  userId: number,
  options: ForecastOptions = {},
): Forecast {
  const reference = options.asOf ?? today();
  const month = options.month ?? monthOf(reference);
  if (!isValidMonth(month)) {
    throw new FinError(`Mês inválido: ${JSON.stringify(month)}. Use YYYY-MM.`);
  }

  const period = periodRange(month);
  const monthStart = period.start;
  const monthEnd = period.end;
  const daysInMonth = dayOfMonth(monthEnd);

  const currentMonth = monthOf(reference);
  const closed = month < currentMonth;
  const future = month > currentMonth;

  // `asOf` is the last day already observed. For a month that has not started it
  // sits before the month, which makes every "already spent" window empty
  // without any special-casing downstream.
  const asOf = closed ? monthEnd : future ? addDays(monthStart, -1) : reference;
  const elapsed = closed ? daysInMonth : future ? 0 : dayOfMonth(reference);
  const remainingDates = closed ? [] : datesBetween(addDays(asOf, 1), monthEnd);

  /* ---- parts 1, 3 and 4: the certain side ------------------------------- */

  const spent = expenseTotal(db, userId, monthStart, asOf);
  // A closed month has nothing left to post: whatever `recurring` still owes it
  // is `recurring apply`'s business, not a forecast's.
  const fixed = closed ? [] : pendingFixed(db, userId, monthStart, monthEnd, asOf);
  const fixedTotal = fixed.reduce((acc, f) => acc + f.amount_cents, 0);
  const scheduledByDate = expensesByDate(db, userId, addDays(asOf, 1), monthEnd);
  let scheduledTotal = 0;
  for (const cents of scheduledByDate.values()) scheduledTotal += cents;
  const scheduledCount = scheduledByDate.size;

  /* ---- part 2: the estimate --------------------------------------------- */

  const firstDate = firstActivity(db, userId);
  const historyWindows: SampleWindow[] = [];
  for (let back = 1; back <= HISTORY_MONTHS; back++) {
    const m = monthOf(addMonths(monthStart, -back));
    const range = periodRange(m);
    // Do not count days before this person had a ledger: signing up on the 20th
    // would otherwise look like 19 days of spending nothing.
    const start = firstDate && firstDate > range.start ? firstDate : range.start;
    if (start > range.end) continue;
    historyWindows.push({
      month: m,
      start,
      end: range.end,
      days: datesBetween(start, range.end).length,
    });
  }

  const currentWindow: SampleWindow | null =
    elapsed > 0
      ? { month, start: monthStart, end: asOf, days: elapsed }
      : null;

  const sampleStart = historyWindows.length
    ? historyWindows[historyWindows.length - 1].start
    : monthStart;
  const sampleEnd = currentWindow ? asOf : monthStart;
  const samples = variableByDate(db, userId, sampleStart, sampleEnd);

  const ctx: RateContext = {
    current: currentWindow,
    history: historyWindows,
    daysInMonth,
    elapsed,
  };
  const rate = closed
    ? {
        basis: "closed" as RateBasis,
        centsPerDay: null,
        current: null,
        history: null,
        weightCurrent: 0,
        months: [],
        historyDays: 0,
      }
    : computeRate(samples, ctx);

  // Complete months only, when there are any: the weekday/weekend *shape* is what
  // is wanted here, and a partial current month biases it badly — a single big
  // purchase on the 2nd would decide what "a Sunday costs" for the whole month.
  // The current window is used only when it is all there is, and then the sample
  // guards in `dayProfile` almost always refuse anyway.
  const profileWindows = historyWindows.length
    ? historyWindows
    : currentWindow
      ? [currentWindow]
      : [];
  const profile =
    rate.centsPerDay === null ? FLAT_PROFILE : dayProfile(samples, profileWindows);

  let weightedRemaining = 0;
  for (const date of remainingDates) weightedRemaining += dayWeight(date, profile);

  const estimate =
    rate.centsPerDay === null ? null : Math.round(rate.centsPerDay * weightedRemaining);

  /* ---- the total, and how much of it is a guess ------------------------- */

  const certain = spent + fixedTotal + scheduledTotal;
  const estimated = estimate ?? 0;
  const projected = certain + estimated;
  const certainPct = projected > 0 ? Math.round((certain * 100) / projected) : 100;

  const confidence: Confidence = closed
    ? "high"
    : rate.basis === "insufficient"
      ? "none"
      : (rate.months.length >= 2 && elapsed >= 10) || certainPct >= 90
        ? "high"
        : rate.months.length >= 1 || elapsed >= 14
          ? "medium"
          : "low";

  /* ---- per budget ------------------------------------------------------- */

  const budgets = forecastBudgets(db, userId, {
    month,
    monthStart,
    monthEnd,
    asOf,
    remainingDates,
    ctx,
    profile,
    globalBasis: rate.basis,
    fixed,
  });

  const result: Forecast = {
    month,
    month_label: monthLabel(month),
    as_of: asOf,
    closed,
    days_in_month: daysInMonth,
    days_elapsed: elapsed,
    days_remaining: remainingDates.length,

    spent_cents: spent,
    spent_fmt: formatMoney(spent),
    fixed_pending_cents: fixedTotal,
    fixed_pending_fmt: formatMoney(fixedTotal),
    fixed_pending: fixed,
    scheduled_cents: scheduledTotal,
    scheduled_fmt: formatMoney(scheduledTotal),
    scheduled_count: scheduledCount,
    variable_estimate_cents: estimate,
    variable_estimate_fmt: estimate === null ? null : formatMoney(estimate),

    projected_total_cents: projected,
    projected_total_fmt: formatMoney(projected),
    certain_cents: certain,
    certain_fmt: formatMoney(certain),
    estimated_cents: estimated,
    estimated_fmt: formatMoney(estimated),
    certain_pct: certainPct,

    rate: {
      basis: rate.basis,
      cents_per_day: rate.centsPerDay === null ? null : Math.round(rate.centsPerDay),
      cents_per_day_fmt:
        rate.centsPerDay === null ? null : formatMoney(Math.round(rate.centsPerDay)),
      current_cents_per_day: rate.current === null ? null : Math.round(rate.current),
      history_cents_per_day: rate.history === null ? null : Math.round(rate.history),
      weight_current: Math.round(rate.weightCurrent * 100) / 100,
      history_months: rate.months,
      history_days: rate.historyDays,
      observed_days: elapsed,
      weekend_adjusted: profile.adjusted,
      weekend_factor: Math.round(profile.weekend * 100) / 100,
      weekday_factor: Math.round(profile.weekday * 100) / 100,
    },
    confidence,
    confidence_label: CONFIDENCE_LABEL[confidence],

    budgets,
    text: "",
    // Nothing worth waking somebody up for: a closed month, no data at all, or a
    // projection sitting comfortably inside every limit. Same convention as
    // `alerts` in fin.ts, so a cron job can reply [SILENT].
    silent: closed
      ? true
      : budgets.some((b) => b.status !== "ok")
        ? false
        : true,
  };

  result.text = forecastText(result);
  return result;
}

interface BudgetContext {
  month: string;
  monthStart: string;
  monthEnd: string;
  asOf: string;
  remainingDates: string[];
  ctx: RateContext;
  profile: DayProfile;
  globalBasis: RateBasis;
  fixed: PendingFixed[];
}

/**
 * Each budget, projected to the end of the month.
 *
 * A month-specific budget wins over the recurring one (month NULL) for the same
 * category, exactly as `budgetStatuses` does in `fin.ts`.
 */
function forecastBudgets(
  db: Db,
  userId: number,
  c: BudgetContext,
): BudgetForecast[] {
  const rows = db
    .prepare(
      "SELECT category_id, month, limit_cents, alert_pct FROM budgets " +
        "WHERE user_id = ? AND (month IS NULL OR month = ?) ORDER BY (month IS NULL)",
    )
    .all(userId, c.month) as BudgetRow[];

  const seen = new Set<number | null>();
  const out: BudgetForecast[] = [];

  for (const b of rows) {
    if (seen.has(b.category_id)) continue;
    seen.add(b.category_id);

    const ids = b.category_id
      ? categoryAndChildrenIds(db, userId, b.category_id)
      : null;
    const name = b.category_id
      ? fullCategoryName(db, userId, b.category_id)
      : "Total do mês";

    const spent = expenseTotal(db, userId, c.monthStart, c.asOf, ids);
    const scheduledByDate = expensesByDate(
      db,
      userId,
      addDays(c.asOf, 1),
      c.monthEnd,
      ids,
    );
    let scheduled = 0;
    for (const cents of scheduledByDate.values()) scheduled += cents;

    const idSet = ids ? new Set(ids) : null;
    const fixedItems = c.fixed.filter(
      (f) => !idSet || (f.category_id !== null && idSet.has(f.category_id)),
    );
    const fixedTotal = fixedItems.reduce((acc, f) => acc + f.amount_cents, 0);

    // The category's own rate, on the same model as the global one. When the
    // global model has nothing to stand on, neither does this one.
    let centsPerDay = 0;
    if (c.globalBasis !== "insufficient" && c.globalBasis !== "closed") {
      const samples = variableByDate(
        db,
        userId,
        c.ctx.history.length
          ? c.ctx.history[c.ctx.history.length - 1].start
          : c.monthStart,
        c.ctx.current ? c.asOf : c.monthStart,
        ids,
      );
      const scoped = computeRate(samples, c.ctx);
      // "insufficient" for a category only means this category has no previous
      // months; the elapsed window is the same one the global model trusts, so
      // its own average (possibly zero) is the honest answer.
      centsPerDay = scoped.centsPerDay ?? scoped.current ?? 0;
    }

    let weightedRemaining = 0;
    for (const date of c.remainingDates) weightedRemaining += dayWeight(date, c.profile);
    const estimated = Math.round(centsPerDay * weightedRemaining);

    const projected = spent + scheduled + fixedTotal + estimated;
    const limit = Number(b.limit_cents);
    const projectedPct = limit ? Math.round((projected * 1000) / limit) / 10 : 0;
    const currentPct = limit ? Math.round((spent * 1000) / limit) / 10 : 0;

    /* Day-by-day walk to the crossing point.
     *
     * Same three ingredients as the total, applied in date order: the known
     * amounts on the days they fall on, plus the rate on every day. Overdue fixed
     * costs are added up front — they are owed already, whatever day they end up
     * being posted on. */
    let crossing: string | null = null;
    if (spent < limit) {
      let cumulative = spent;
      for (const f of fixedItems) if (f.overdue) cumulative += f.amount_cents;
      if (cumulative >= limit && c.remainingDates.length) {
        crossing = c.remainingDates[0];
      } else {
        const dueOn = new Map<string, number>();
        for (const f of fixedItems) {
          if (f.overdue) continue;
          dueOn.set(f.date, (dueOn.get(f.date) ?? 0) + f.amount_cents);
        }
        for (const date of c.remainingDates) {
          cumulative += scheduledByDate.get(date) ?? 0;
          cumulative += dueOn.get(date) ?? 0;
          cumulative += centsPerDay * dayWeight(date, c.profile);
          if (cumulative >= limit) {
            crossing = date;
            break;
          }
        }
      }
    }

    out.push({
      category_id: b.category_id,
      category: name,
      month_specific: b.month !== null,
      limit_cents: limit,
      limit_fmt: formatMoney(limit),
      spent_cents: spent,
      spent_fmt: formatMoney(spent),
      fixed_pending_cents: fixedTotal,
      scheduled_cents: scheduled,
      estimated_cents: estimated,
      projected_cents: projected,
      projected_fmt: formatMoney(projected),
      projected_pct: projectedPct,
      alert_pct: b.alert_pct,
      status: statusOf(projectedPct, b.alert_pct),
      current_status: statusOf(currentPct, b.alert_pct),
      over_projected: projected >= limit,
      overflow_cents: Math.max(0, projected - limit),
      overflow_fmt: formatMoney(Math.max(0, projected - limit)),
      already_over: spent >= limit,
      crossing_date: crossing,
      crossing_day: crossing === null ? null : dayOfMonth(crossing),
    });
  }

  out.sort((a, b) => b.projected_pct - a.projected_pct);
  return out;
}

/* -------------------------------------------------------------------------- */
/* The text                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The forecast in Portuguese, ready to send on Telegram.
 *
 * Same shape as `cmdReport` in `fin.ts`: no markdown tables (Telegram does not
 * render them), no column alignment, one fact per line, an emoji as the anchor.
 *
 * The tone is the bot's: it reports and it projects, and it does not have an
 * opinion. No warning about spending "too much", no suggestion to cut anything,
 * no exclamation marks. A projection above a limit is stated as a date and an
 * amount — which is the useful part — and nothing else is added to it.
 */
function forecastText(f: Forecast): string {
  const lines: string[] = [];
  lines.push(`🔮 *Previsão — ${f.month_label}*`);

  if (f.closed) {
    lines.push("_mês fechado, estes são os valores reais_");
    lines.push("");
    lines.push(`💸 Total do mês: *${f.spent_fmt}*`);
    return lines.join("\n");
  }

  const remaining = f.days_remaining;
  lines.push(
    remaining === 0
      ? `_${shortDate(f.as_of)}, último dia do mês_`
      : `_${shortDate(f.as_of)}, ${remaining} dia(s) até o fim do mês_`,
  );
  lines.push("");
  lines.push(`💸 Já saiu: *${f.spent_fmt}*`);
  if (f.fixed_pending_cents > 0) {
    lines.push(`🔁 Fixos ainda por lançar: *${f.fixed_pending_fmt}*`);
  }
  if (f.scheduled_cents > 0) {
    lines.push(`🧾 Parcelas já agendadas: *${f.scheduled_fmt}*`);
  }

  if (f.variable_estimate_cents === null) {
    lines.push("");
    lines.push(
      "🤷 Ainda não tenho histórico suficiente para projetar o fechamento do mês. " +
        "Com mais alguns dias registrados eu consigo.",
    );
    if (f.certain_cents > 0) {
      lines.push(`Do que já é certo, o mês soma ${f.certain_fmt}.`);
    }
    return lines.join("\n");
  }

  lines.push(`📈 Variável estimado até o fim: *${f.variable_estimate_fmt}*`);
  lines.push(`🎯 No ritmo atual, o mês fecha em *${f.projected_total_fmt}*`);

  const history = f.rate.history_months.length;
  const historyText =
    history === 0
      ? "sem meses anteriores no cálculo"
      : history === 1
        ? "1 mês anterior no cálculo"
        : `${history} meses anteriores no cálculo`;
  lines.push(
    `_Confiança ${f.confidence_label}: ${f.days_elapsed} dia(s) deste mês, ` +
      `${historyText}. ${f.certain_pct}% do valor já é certo._`,
  );

  if (f.budgets.length) {
    lines.push("");
    lines.push("*Orçamentos:*");
    for (const b of f.budgets) {
      const icon = b.status === "over" ? "🔴" : b.status === "warning" ? "🟡" : "🟢";
      if (b.already_over) {
        lines.push(
          `${icon} ${b.category}: ${b.spent_fmt} de ${b.limit_fmt}, o limite já foi passado.`,
        );
      } else if (b.crossing_date) {
        lines.push(
          `${icon} ${b.category}: projeção de ${b.projected_fmt} para um limite de ` +
            `${b.limit_fmt} — no ritmo atual, estoura dia ${b.crossing_day}.`,
        );
      } else {
        lines.push(
          `${icon} ${b.category}: projeção de ${b.projected_fmt} de ${b.limit_fmt} ` +
            `(${Math.round(b.projected_pct)}%).`,
        );
      }
    }
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The subcommand shape `fin.ts` uses: takes an already-authenticated internal
 * user id and the parsed options, returns the JSON body (without `ok`).
 */
export function cmdForecast(db: Db, userId: number, a: Args): Output {
  const month = typeof a.month === "string" ? a.month : undefined;
  const asOf = typeof a["as-of"] === "string" ? a["as-of"] : undefined;
  return forecast(db, userId, { month, asOf });
}

const USAGE = `End-of-month forecast for one person's ledger.

  node forecast.ts --db PATH --user-id <users.id> [--month YYYY-MM] [--json]

  --user-id   internal users.id (an integer), not a Telegram id
  --month     the month to project; defaults to the current one
  --as-of     pretend today is this date (YYYY-MM-DD); for tests and backfills
  --json      print the full JSON body instead of the Portuguese text

Without --json it prints the ready-to-send Portuguese text. Errors are always
JSON — {"ok": false, "error": "..."} — with exit code 1.
`;

const OPTIONS = {
  db: { type: "string" },
  "user-id": { type: "string" },
  month: { type: "string" },
  "as-of": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

export function main(argv: string[]): number {
  try {
    let values: Args;
    try {
      values = parseArgs({ args: argv, options: OPTIONS as never, strict: true })
        .values as Args;
    } catch (e) {
      throw new FinError(
        `${(e as Error).message}. Opções aceitas: ` +
          `${Object.keys(OPTIONS).map((k) => `--${k}`).join(", ")}.`,
      );
    }

    if (values.help === true) {
      process.stdout.write(USAGE);
      return 0;
    }

    const raw = typeof values["user-id"] === "string" ? values["user-id"] : undefined;
    if (raw === undefined || raw.trim() === "") {
      throw new FinError("Informe --user-id (o id interno do usuário).");
    }
    const userId = Number(raw);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new FinError("--user-id precisa ser um número inteiro positivo.");
    }

    const db = connect(typeof values.db === "string" ? values.db : process.env.TALLY_DB);
    let output: Output;
    try {
      if (currentVersion(db) < CURRENT_SCHEMA_VERSION) migrate(db);
      // Not an authentication check — that is `fin.ts`'s job — just a guard so a
      // mistyped id reports itself instead of returning an empty forecast that
      // looks like a month with no spending.
      const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
      if (!exists) throw new FinError("Não encontrei esse usuário.");
      output = cmdForecast(db, userId, values);
    } finally {
      db.close();
    }

    if (values.json === true) {
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
