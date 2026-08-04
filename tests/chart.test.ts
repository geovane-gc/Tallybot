/**
 * Tests for the chart module.
 *
 * The point of these is not that a file was written — a corrupt PNG is also a
 * file. They decode what was produced and check it: the chunk structure and every
 * CRC, the scanlines against the dimensions in IHDR, and the actual blue pixels
 * of the bars against the amounts that went in. Plus the two things that would be
 * quietly wrong forever otherwise: that one person's chart never contains the
 * other person's money, and that an empty period produces a sentence instead of a
 * division by zero.
 *
 *     node --test tests/chart.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 as zlibCrc32, inflateSync } from "node:zlib";

import {
  addMonths,
  connect,
  formatMoney,
  init,
  monthOf,
  now,
  resolveCategory,
  seedUser,
  today,
  type Db,
} from "../skills/finance/scripts/db.ts";

import {
  CATEGORY_LAYOUT,
  COLORS,
  Canvas,
  barWidths,
  buildChart,
  chartCategory,
  chartCumulative,
  chartTrend,
  crc32,
  cumulativeSeries,
  drawCategoryChart,
  encodePng,
  fitText,
  monthlySeries,
  textBar,
} from "../skills/finance/scripts/chart.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "skills", "finance", "scripts", "chart.ts");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The month before this one: fully in the past, so no test depends on "today". */
const PAST_MONTH = monthOf(addMonths(`${monthOf(today())}-01`, -1));
const THIS_MONTH = monthOf(today());

interface Fixture {
  path: string;
  db: Db;
  userA: number;
  userB: number;
}

/**
 * A database built through the real migrations and the real seeding.
 *
 * Nothing here writes DDL: `init` applies the migrations and `seedUser` creates
 * the taxonomy, so the fixtures cannot drift from the schema the bot runs on.
 */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tally-chart-"));
  const path = join(dir, "tally.db");
  init(path);
  const db = connect(path);
  return { path, db, userA: makeUser(db, "111111111"), userB: makeUser(db, "222222222") };
}

function makeUser(db: Db, telegramId: string): number {
  const info = db
    .prepare(
      "INSERT INTO users (telegram_user_id, display_name, authenticated_at, auth_epoch, created_at) " +
        "VALUES (?, ?, ?, 0, ?)",
    )
    .run(telegramId, `Pessoa ${telegramId}`, now(), now());
  const id = Number(info.lastInsertRowid);
  seedUser(db, id);
  return id;
}

function addExpense(
  db: Db,
  userId: number,
  cents: number,
  category: string,
  date: string,
  type: "expense" | "income" = "expense",
): void {
  const categoryId = resolveCategory(db, userId, category, true);
  const account = db
    .prepare("SELECT id FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1")
    .get(userId) as { id: number };
  db.prepare(
    "INSERT INTO transactions (user_id, type, amount_cents, description, date, " +
      "category_id, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(userId, type, cents, `Teste ${category}`, date, categoryId, account.id, now(), now());
}

/**
 * A root category with the exact name given.
 *
 * `resolveCategory(create)` would file an unknown name under "Outros" as a
 * subcategory, and the chart rolls subcategories up to their root — so a test
 * about a long *root* name has to create the root itself.
 */
function addRootCategory(db: Db, userId: number, name: string): void {
  db.prepare(
    "INSERT INTO categories (user_id, name, parent_id, type, emoji) VALUES (?, ?, NULL, 'expense', ?)",
  ).run(userId, name, "🧾");
}

function setCap(db: Db, userId: number, cents: number, month: string | null = null): void {
  db.prepare(
    "INSERT INTO budgets (user_id, category_id, month, limit_cents, alert_pct, created_at) " +
      "VALUES (?, NULL, ?, ?, 80, ?)",
  ).run(userId, month, cents, now());
}

/* -------------------------------------------------------------------------- */
/* PNG decoding, for the assertions below                                     */
/* -------------------------------------------------------------------------- */

interface Chunk {
  type: string;
  data: Buffer;
  crcOk: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Walks the chunk structure, checking each CRC.
 *
 * The CRC oracle is `zlib.crc32`, not the module's own table — checking a
 * checksum with the implementation that produced it proves nothing.
 */
function readChunks(png: Buffer): Chunk[] {
  assert.deepEqual([...png.subarray(0, 8)], SIGNATURE, "PNG signature");
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    const computed = zlibCrc32(png.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, data, crcOk: stored === computed });
    offset += 12 + length;
  }
  assert.equal(offset, png.length, "chunks cover the file exactly");
  return chunks;
}

interface Decoded {
  width: number;
  height: number;
  /** One row per scanline, `width * 4` bytes each (the filter byte removed). */
  rows: Buffer[];
}

function decodePng(png: Buffer): Decoded {
  const chunks = readChunks(png);
  for (const chunk of chunks) {
    assert.ok(chunk.crcOk, `CRC of chunk ${chunk.type}`);
  }
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks[chunks.length - 1].type, "IEND");
  const idat = chunks.filter((c) => c.type === "IDAT");
  assert.ok(idat.length >= 1, "at least one IDAT");

  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.equal(ihdr[8], 8, "bit depth");
  assert.equal(ihdr[9], 6, "colour type RGBA");
  assert.equal(ihdr[10], 0, "deflate");
  assert.equal(ihdr[12], 0, "not interlaced");

  const raw = inflateSync(Buffer.concat(idat.map((c) => c.data)));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height, "inflated size matches IHDR");

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    assert.equal(raw[at], 0, `scanline ${y} filter byte`);
    rows.push(raw.subarray(at + 1, at + 1 + stride));
  }
  assert.equal(rows.length, height);
  for (const row of rows) assert.equal(row.length, stride);
  return { width, height, rows };
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function isColor(row: Buffer, x: number, colour: [number, number, number]): boolean {
  const at = x * 4;
  return row[at] === colour[0] && row[at + 1] === colour[1] && row[at + 2] === colour[2];
}

/** The longest horizontal run of `hex` in each scanline that contains any. */
function runsOf(decoded: Decoded, hex: string): { y: number; length: number }[] {
  const colour = rgb(hex);
  const out: { y: number; length: number }[] = [];
  decoded.rows.forEach((row, y) => {
    let best = 0;
    let current = 0;
    for (let x = 0; x < decoded.width; x++) {
      if (isColor(row, x, colour)) {
        current++;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    }
    if (best > 0) out.push({ y, length: best });
  });
  return out;
}

/**
 * One entry per band of consecutive scanlines holding the same run length.
 *
 * A horizontal bar is many identical scanlines; collapsing them gives one number
 * per bar, in top-to-bottom order, which is what the proportionality assertions
 * compare against the amounts.
 */
function barLengths(decoded: Decoded, hex: string): number[] {
  const runs = runsOf(decoded, hex);
  const bars: number[] = [];
  let previousY = -10;
  let currentMax = 0;
  for (const run of runs) {
    if (run.y !== previousY + 1) {
      if (currentMax) bars.push(currentMax);
      currentMax = 0;
    }
    currentMax = Math.max(currentMax, run.length);
    previousY = run.y;
  }
  if (currentMax) bars.push(currentMax);
  return bars;
}

/* -------------------------------------------------------------------------- */

describe("PNG encoding", () => {
  test("crc32 matches the reference vector and zlib", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    const bytes = Buffer.from("Alimentação, Saúde, Dívidas", "utf8");
    assert.equal(crc32(bytes), zlibCrc32(bytes));
  });

  test("a hand-made buffer round-trips through the encoder", () => {
    const width = 7;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4).fill(200);
    const decoded = decodePng(encodePng(width, height, rgba));
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.equal(decoded.rows.length, height);
    assert.deepEqual([...decoded.rows[0]], [...rgba.subarray(0, width * 4)]);
  });

  test("a canvas reports the same dimensions the PNG declares", () => {
    const canvas = new Canvas(100, 40, 2);
    const decoded = decodePng(canvas.toPng());
    assert.equal(decoded.width, canvas.width);
    assert.equal(decoded.height, canvas.height);
    assert.equal(canvas.width, 200);
    assert.equal(canvas.height, 80);
  });
});

describe("category chart", () => {
  test("the file is a structurally valid PNG of the size reported", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 100_00, "Alimentação", `${PAST_MONTH}-05`);
    addExpense(f.db, f.userA, 50_00, "Transporte", `${PAST_MONTH}-06`);

    const result = chartCategory(f.db, f.userA, { period: PAST_MONTH, dbPath: f.path });
    assert.equal(result.empty, false);
    assert.ok(result.file && existsSync(result.file));
    assert.match(result.file, /charts\/tally-u\d+-category-.*\.png$/);

    const decoded = decodePng(readFileSync(result.file));
    assert.equal(decoded.width, result.width);
    assert.equal(decoded.height, result.height);
    f.db.close();
  });

  test("bar pixels are proportional to the amounts", () => {
    const f = fixture();
    // Moradia is double Alimentação, which is double Transporte.
    addExpense(f.db, f.userA, 400_00, "Moradia", `${PAST_MONTH}-02`);
    addExpense(f.db, f.userA, 200_00, "Alimentação", `${PAST_MONTH}-03`);
    addExpense(f.db, f.userA, 100_00, "Transporte", `${PAST_MONTH}-04`);

    const result = chartCategory(f.db, f.userA, { period: PAST_MONTH, dbPath: f.path });
    const bars = barLengths(decodePng(readFileSync(result.file!)), COLORS.expense);
    assert.equal(bars.length, 3, "one bar per category");

    // Sorted by amount, so the first bar is the longest and each is about half
    // the one above it. The rounded data-end costs a few pixels, hence the 4%.
    assert.ok(bars[0] > bars[1] && bars[1] > bars[2], `descending: ${bars}`);
    assert.ok(Math.abs(bars[1] / bars[0] - 0.5) < 0.04, `half: ${bars}`);
    assert.ok(Math.abs(bars[2] / bars[0] - 0.25) < 0.04, `quarter: ${bars}`);
    // The longest bar fills the space allotted to it.
    assert.equal(bars[0], Math.round(CATEGORY_LAYOUT.barMax * 2));
    f.db.close();
  });

  test("barWidths scales to the largest value and keeps a stub for the smallest", () => {
    assert.deepEqual(barWidths([100, 50, 0], 200), [200, 100, 0]);
    const [big, tiny] = barWidths([1_000_00, 1], 300);
    assert.equal(big, 300);
    assert.ok(tiny >= 3, "a real expense is never a zero-width bar");
  });

  test("the percentages in the text version add up to about 100", () => {
    const f = fixture();
    const amounts: [string, number][] = [
      ["Moradia", 250_000], ["Alimentação", 123_456], ["Transporte", 61_728],
      ["Saúde", 8_990], ["Lazer", 15_000], ["Pets", 4_500], ["Educação", 3_200],
      ["Compras", 9_100], ["Serviços", 2_750], ["Assinaturas", 1_990],
      ["Impostos e taxas", 7_777], ["Dívidas", 5_000],
    ];
    amounts.forEach(([category, cents], i) =>
      addExpense(f.db, f.userA, cents, category, `${PAST_MONTH}-${String(i + 1).padStart(2, "0")}`),
    );

    const result = chartCategory(f.db, f.userA, {
      period: PAST_MONTH,
      dbPath: f.path,
      png: false,
    });
    const percentages = [...result.text.matchAll(/\((\d+)%\)/g)].map((m) => Number(m[1]));
    assert.ok(percentages.length >= 5, "one percentage per bar");
    const total = percentages.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 100) <= 3, `percentages summed to ${total}`);
    // The tail is folded into one bar, so nothing is silently dropped.
    assert.match(result.text, /Outras \(\d+\)/);
    f.db.close();
  });

  test("the text bars are left-anchored and all the same width", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 300_00, "Alimentação", `${PAST_MONTH}-05`);
    addExpense(f.db, f.userA, 20_00, "Transporte", `${PAST_MONTH}-06`);

    const result = chartCategory(f.db, f.userA, {
      period: PAST_MONTH,
      dbPath: f.path,
      png: false,
    });
    const bars = result.text
      .split("\n")
      .filter((l) => l.startsWith("█") || l.startsWith("░"));
    assert.equal(bars.length, 2);
    for (const line of bars) {
      const cells = [...line.split(" ")[0]];
      assert.equal(cells.length, 12, `bar is 12 cells: ${line}`);
      assert.ok(cells.every((c) => c === "█" || c === "░"));
    }
    // Biggest first, and its bar is full.
    assert.ok(bars[0].startsWith("████████████"));
    assert.match(result.text, /R\$ 300,00/);
    f.db.close();
  });

  test("one category is 100% and still renders", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 42_00, "Alimentação", `${PAST_MONTH}-09`);
    const result = chartCategory(f.db, f.userA, { period: PAST_MONTH, dbPath: f.path });
    assert.match(result.text, /\(100%\)/);
    const decoded = decodePng(readFileSync(result.file!));
    const bars = barLengths(decoded, COLORS.expense);
    assert.equal(bars.length, 1);
    assert.equal(bars[0], Math.round(CATEGORY_LAYOUT.barMax * 2));
    f.db.close();
  });

  test("an empty period explains itself in Portuguese instead of drawing", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 10_00, "Alimentação", `${PAST_MONTH}-09`);

    // A month with nothing in it: no file, no NaN, no crash.
    const empty = monthOf(addMonths(`${PAST_MONTH}-01`, -6));
    const result = chartCategory(f.db, f.userA, { period: empty, dbPath: f.path });
    assert.equal(result.empty, true);
    assert.equal(result.file, null);
    assert.equal(result.width, null);
    assert.match(result.text, /Nenhum gasto registrado/);
    assert.doesNotMatch(result.text, /NaN|undefined|Infinity/);
    f.db.close();
  });

  test("a very long category name is truncated instead of overflowing", () => {
    const f = fixture();
    const long = "Despesas extraordinárias imprevisíveis do trimestre";
    addRootCategory(f.db, f.userA, long);
    addExpense(f.db, f.userA, 90_00, long, `${PAST_MONTH}-11`);
    addExpense(f.db, f.userA, 30_00, "Transporte", `${PAST_MONTH}-12`);

    const result = chartCategory(f.db, f.userA, { period: PAST_MONTH, dbPath: f.path });
    // The inline version keeps the line short.
    const inline = result.text.split("\n").find((l) => l.startsWith("█"))!;
    assert.ok(inline.includes("…"), `expected an ellipsis in: ${inline}`);

    const decoded = decodePng(readFileSync(result.file!));
    const L = CATEGORY_LAYOUT;
    const scale = decoded.width / L.width;
    const surface = rgb(COLORS.surface);

    // Nothing in the gap between the label column and the axis, on any of the
    // rows the bars live on (the header runs the full width, by design).
    const gapStart = Math.round((L.padding + L.labelWidth) * scale);
    const gapEnd = Math.round((L.barLeft - 8) * scale);
    decoded.rows.forEach((row, y) => {
      if (y >= L.headerHeight * scale) {
        for (let x = gapStart; x < gapEnd; x++) {
          assert.ok(isColor(row, x, surface), `ink at (${x},${y}) — the label overflowed`);
        }
      }
      assert.ok(isColor(row, 0, surface), "ink on the left edge");
      assert.ok(isColor(row, decoded.width - 1, surface), "ink on the right edge");
    });
    f.db.close();
  });

  test("a huge amount keeps its value label inside the image", () => {
    // Straight through the renderer: an amount in the millions is rarer than a
    // test run, and the value column is the part that would run off the edge.
    const amount = 123_456_789;
    const canvas = drawCategoryChart(
      [
        {
          category: "Investimentos",
          emoji: "📈",
          total_cents: amount,
          total_fmt: formatMoney(amount),
          count: 3,
          pct: 100,
        },
      ],
      "Teste de largura",
      "valores muito grandes",
    );
    const decoded = decodePng(canvas.toPng());
    const surface = rgb(COLORS.surface);
    for (const row of decoded.rows) {
      assert.ok(isColor(row, decoded.width - 1, surface), "ink on the right edge");
      assert.ok(isColor(row, decoded.width - 2, surface));
    }
  });
});

describe("privacy between the two users", () => {
  test("each chart holds only its own owner's numbers", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 800_00, "Moradia", `${PAST_MONTH}-02`);
    addExpense(f.db, f.userA, 200_00, "Alimentação", `${PAST_MONTH}-03`);
    addExpense(f.db, f.userB, 37_00, "Pets", `${PAST_MONTH}-04`);

    const a = chartCategory(f.db, f.userA, { period: PAST_MONTH, dbPath: f.path });
    const b = chartCategory(f.db, f.userB, { period: PAST_MONTH, dbPath: f.path });

    assert.match(a.text, /R\$ 1\.000,00/);
    assert.match(a.text, /Moradia/);
    assert.doesNotMatch(a.text, /Pets|R\$ 37,00/);

    assert.match(b.text, /Pets/);
    assert.match(b.text, /R\$ 37,00/);
    assert.doesNotMatch(b.text, /Moradia|Alimentação|R\$ 800,00/);

    // Different files, and the bars in the image differ too — the same numbers
    // would mean the filter was ignored somewhere.
    assert.notEqual(a.file, b.file);
    assert.equal(barLengths(decodePng(readFileSync(a.file!)), COLORS.expense).length, 2);
    assert.equal(barLengths(decodePng(readFileSync(b.file!)), COLORS.expense).length, 1);
    f.db.close();
  });

  test("the trend and the cumulative chart are scoped too", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 500_00, "Moradia", `${THIS_MONTH}-01`);
    addExpense(f.db, f.userB, 11_00, "Pets", `${THIS_MONTH}-01`);
    setCap(f.db, f.userA, 1_000_00);

    const trendA = chartTrend(f.db, f.userA, { months: 3, dbPath: f.path, png: false });
    const trendB = chartTrend(f.db, f.userB, { months: 3, dbPath: f.path, png: false });
    assert.match(trendA.text, /R\$ 500,00/);
    assert.doesNotMatch(trendA.text, /R\$ 11,00/);
    assert.match(trendB.text, /R\$ 11,00/);
    assert.doesNotMatch(trendB.text, /R\$ 500,00/);

    const cumulativeA = chartCumulative(f.db, f.userA, { dbPath: f.path, png: false });
    const cumulativeB = chartCumulative(f.db, f.userB, { dbPath: f.path, png: false });
    assert.match(cumulativeA.text, /Limite do mês R\$ 1\.000,00/);
    assert.match(cumulativeA.text, /R\$ 500,00/);
    // B has no budget of its own: A's cap must not leak into B's chart.
    assert.doesNotMatch(cumulativeB.text, /Limite/);
    assert.doesNotMatch(cumulativeB.text, /R\$ 500,00/);

    const seriesA = cumulativeSeries(f.db, f.userA, THIS_MONTH);
    const seriesB = cumulativeSeries(f.db, f.userB, THIS_MONTH);
    assert.equal(seriesA.total_cents, 500_00);
    assert.equal(seriesA.cap_cents, 1_000_00);
    assert.equal(seriesB.total_cents, 11_00);
    assert.equal(seriesB.cap_cents, null);
    f.db.close();
  });
});

describe("trend chart", () => {
  test("months with nothing in them stay in the series as zeroes", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 100_00, "Moradia", `${THIS_MONTH}-01`);
    const points = monthlySeries(f.db, f.userA, 4);
    assert.equal(points.length, 4);
    assert.deepEqual(points.map((p) => p.expenses_cents), [0, 0, 0, 100_00]);
    assert.equal(points[3].month, THIS_MONTH);
    f.db.close();
  });

  test("expenses and income both reach the drawing, with a legend", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 300_00, "Moradia", `${THIS_MONTH}-01`);
    addExpense(f.db, f.userA, 900_00, "Salário", `${THIS_MONTH}-01`, "income");

    const result = chartTrend(f.db, f.userA, { months: 3, dbPath: f.path });
    assert.match(result.text, /Média mensal/);
    assert.match(result.text, /Entradas no período: R\$ 900,00/);

    const decoded = decodePng(readFileSync(result.file!));
    assert.equal(decoded.width, result.width);
    // Both series present: the income column is drawn in its own colour.
    assert.ok(runsOf(decoded, COLORS.expense).length > 0, "expense column");
    assert.ok(runsOf(decoded, COLORS.income).length > 0, "income column");
    f.db.close();
  });

  test("a period with no movement at all says so", () => {
    const f = fixture();
    const result = chartTrend(f.db, f.userA, { months: 6, dbPath: f.path });
    assert.equal(result.empty, true);
    assert.equal(result.file, null);
    assert.match(result.text, /Nenhum lançamento nos últimos 6 meses/);
    f.db.close();
  });

  test("an out-of-range month count is refused in Portuguese", () => {
    const f = fixture();
    for (const months of [1, 25, 0, -3]) {
      assert.throws(() => chartTrend(f.db, f.userA, { months, png: false }), /entre 2 e 24 meses/);
    }
    f.db.close();
  });
});

describe("cumulative chart", () => {
  test("the daily series accumulates and never regresses", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 100_00, "Moradia", `${PAST_MONTH}-01`);
    addExpense(f.db, f.userA, 50_00, "Alimentação", `${PAST_MONTH}-05`);
    addExpense(f.db, f.userA, 25_00, "Transporte", `${PAST_MONTH}-28`);

    const data = cumulativeSeries(f.db, f.userA, PAST_MONTH);
    assert.equal(data.points.length, data.days_in_month);
    assert.equal(data.points[0].cumulative_cents, 100_00);
    assert.equal(data.points[4].cumulative_cents, 150_00);
    assert.equal(data.total_cents, 175_00);
    for (let i = 1; i < data.points.length; i++) {
      assert.ok(data.points[i].cumulative_cents >= data.points[i - 1].cumulative_cents);
    }
    f.db.close();
  });

  test("the cap is drawn and the overshoot is called out", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 600_00, "Moradia", `${PAST_MONTH}-02`);
    setCap(f.db, f.userA, 400_00, PAST_MONTH);

    const result = chartCumulative(f.db, f.userA, { month: PAST_MONTH, dbPath: f.path });
    assert.match(result.text, /Limite do mês R\$ 400,00/);
    assert.match(result.text, /passou do limite em \*R\$ 200,00\*/);

    const decoded = decodePng(readFileSync(result.file!));
    // Above the cap the line switches to the "over" colour, and the reference
    // line itself is drawn in it: both mean red pixels exist.
    assert.ok(runsOf(decoded, COLORS.over).length > 0, "the cap line is drawn");
    f.db.close();
  });

  test("a month-specific cap wins over the recurring one", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 10_00, "Moradia", `${PAST_MONTH}-02`);
    setCap(f.db, f.userA, 900_00, null);
    setCap(f.db, f.userA, 100_00, PAST_MONTH);
    assert.equal(cumulativeSeries(f.db, f.userA, PAST_MONTH).cap_cents, 100_00);
    f.db.close();
  });

  test("with no cap there is no percentage and no division by zero", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 80_00, "Lazer", `${PAST_MONTH}-03`);
    const result = chartCumulative(f.db, f.userA, { month: PAST_MONTH, dbPath: f.path });
    assert.match(result.text, /sem limite definido/);
    assert.doesNotMatch(result.text, /NaN|Infinity/);
    assert.ok(result.file && existsSync(result.file));
    f.db.close();
  });

  test("an empty month is a sentence, not an image", () => {
    const f = fixture();
    const result = chartCumulative(f.db, f.userA, { month: PAST_MONTH, dbPath: f.path });
    assert.equal(result.empty, true);
    assert.equal(result.file, null);
    assert.match(result.text, /Nenhum gasto registrado em/);
    f.db.close();
  });

  test("a malformed month is refused", () => {
    const f = fixture();
    assert.throws(() => chartCumulative(f.db, f.userA, { month: "2026-13" }), /Mês inválido/);
    assert.throws(() => chartCumulative(f.db, f.userA, { month: "agosto" }), /Mês inválido/);
    f.db.close();
  });
});

describe("text rendering", () => {
  test("a bar is always the requested number of cells", () => {
    assert.equal([...textBar(50, 100)].length, 12);
    assert.equal([...textBar(0, 100)].length, 12);
    assert.equal([...textBar(0, 0)].length, 12);
    assert.equal(textBar(100, 100), "█".repeat(12));
    assert.equal(textBar(0, 100), "░".repeat(12));
    // Half the maximum is half the bar.
    assert.equal([...textBar(50, 100)].filter((c) => c === "█").length, 6);
    // A tiny but real amount still shows.
    assert.equal([...textBar(1, 10_000)].filter((c) => c === "█").length, 1);
  });

  test("accented labels are rendered, not stripped", () => {
    const withAccents = new Canvas(200, 30, 1);
    withAccents.text(4, 4, "Alimentação", COLORS.ink, 2);
    const without = new Canvas(200, 30, 1);
    without.text(4, 4, "Alimentacao", COLORS.ink, 2);

    const ink = (canvas: Canvas): number => {
      const surface = rgb(COLORS.surface);
      let count = 0;
      for (let i = 0; i < canvas.data.length; i += 4) {
        if (
          canvas.data[i] !== surface[0] ||
          canvas.data[i + 1] !== surface[1] ||
          canvas.data[i + 2] !== surface[2]
        ) {
          count++;
        }
      }
      return count;
    };

    // Same advance either way, but the accented version has the extra marks: the
    // cedilla and the tilde were drawn rather than quietly dropped.
    assert.equal(
      Canvas.measure("Alimentação", 2),
      Canvas.measure("Alimentacao", 2),
    );
    assert.ok(ink(withAccents) > ink(without), "accent marks contribute pixels");
    assert.ok(ink(without) > 0);
  });

  test("fitText shortens to the width it is given", () => {
    const u = 2;
    const long = "Impostos, taxas e outras coisas compridas";
    const short = fitText(long, 100, u);
    assert.ok(short.endsWith("…"));
    assert.ok(Canvas.measure(short, u) <= 100);
    assert.equal(fitText("Pets", 100, u), "Pets");
  });
});

describe("dispatcher and CLI", () => {
  test("buildChart routes by type and refuses an unknown one", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 20_00, "Lazer", `${THIS_MONTH}-01`);
    assert.equal(buildChart(f.db, f.userA, "category", { png: false }).type, "category");
    assert.equal(buildChart(f.db, f.userA, "trend", { png: false }).type, "trend");
    assert.equal(buildChart(f.db, f.userA, "cumulative", { png: false }).type, "cumulative");
    assert.throws(() => buildChart(f.db, f.userA, "pizza", { png: false }), /Tipo de gráfico inválido/);
    f.db.close();
  });

  test("the CLI writes a file and prints the contract", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 77_00, "Alimentação", `${THIS_MONTH}-01`);
    f.db.close();

    const proc = spawnSync(
      process.execPath,
      [CLI, "--db", f.path, "--user-id", String(f.userA), "--type", "category", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(proc.status, 0, proc.stderr);
    const body = JSON.parse(proc.stdout);
    assert.equal(body.ok, true);
    assert.ok(existsSync(body.file));
    assert.match(body.text, /R\$ 77,00/);
    assert.ok(body.data, "--json includes the numbers");
    decodePng(readFileSync(body.file));
  });

  test("the CLI fails closed, in Portuguese, with exit 1", () => {
    const f = fixture();
    f.db.close();
    const cases: string[][] = [
      ["--db", f.path, "--type", "category"], // no --user-id
      ["--db", f.path, "--user-id", "abc", "--type", "category"],
      ["--db", f.path, "--user-id", String(f.userA), "--type", "pizza"],
      ["--db", f.path, "--user-id", String(f.userA), "--type", "trend", "--months", "99"],
      ["--db", f.path, "--user-id", String(f.userA), "--nonsense"],
    ];
    for (const args of cases) {
      const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(proc.status, 1, `expected exit 1 for ${args.join(" ")}`);
      const body = JSON.parse(proc.stdout);
      assert.equal(body.ok, false);
      assert.ok(body.error && body.error.length > 5, `no message for ${args.join(" ")}`);
      assert.doesNotMatch(body.error, /undefined|SQLITE|TypeError/);
    }
  });

  test("the CLI explains a missing schema and an unknown user", () => {
    const fresh = join(mkdtempSync(join(tmpdir(), "tally-chart-cli-")), "vazio.db");
    const uninitialised = spawnSync(
      process.execPath,
      [CLI, "--db", fresh, "--user-id", "1", "--type", "category"],
      { encoding: "utf8" },
    );
    assert.equal(uninitialised.status, 1);
    assert.match(JSON.parse(uninitialised.stdout).error, /não foi inicializado/);

    const f = fixture();
    f.db.close();
    const unknown = spawnSync(
      process.execPath,
      [CLI, "--db", f.path, "--user-id", "99", "--type", "category"],
      { encoding: "utf8" },
    );
    assert.equal(unknown.status, 1);
    assert.match(JSON.parse(unknown.stdout).error, /Não existe usuário com o id interno 99/);
  });

  test("--no-png returns the text alone", () => {
    const f = fixture();
    addExpense(f.db, f.userA, 12_34, "Pets", `${THIS_MONTH}-01`);
    f.db.close();
    const proc = spawnSync(
      process.execPath,
      [CLI, "--db", f.path, "--user-id", String(f.userA), "--type", "cumulative", "--no-png"],
      { encoding: "utf8" },
    );
    assert.equal(proc.status, 0, proc.stderr);
    const body = JSON.parse(proc.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.file, null);
    assert.match(body.text, /R\$ 12,34/);
  });
});
