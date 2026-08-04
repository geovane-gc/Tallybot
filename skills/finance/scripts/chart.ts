#!/usr/bin/env node
/**
 * Charts for the finance agent: an inline text bar chart plus a PNG.
 *
 * Decisions worth knowing before touching this file:
 *
 * - **The text chart is the product; the PNG is the bonus.** Telegram shows a
 *   message instantly and an image as an attachment the person has to open, so
 *   every command returns `text` (block-character bars, ready to send) and, when
 *   there is data, also a `file`. If the PNG ever fails, the text still answers
 *   the question.
 *
 * - **Text bars are left-anchored.** Telegram renders message text in a
 *   proportional font, so anything aligned with spaces comes out crooked — the
 *   same reason `cmdReport` has no columns. Putting the fixed-width bar *first*
 *   on the line and the ragged label after it means every bar starts at column 0
 *   and has the same cell count, so the bars line up in any font, at any width.
 *   The label being ragged on the right is what text always looks like.
 *
 * - **Horizontal bars, not a pie, for spending by category.** A pie with the
 *   twelve categories this ledger seeds is unreadable at phone size: the slices
 *   below ~5% collapse into slivers, the labels need leader lines, and comparing
 *   two similar slices by angle is exactly what people are bad at. Bars sort by
 *   magnitude (which *is* the question — "where did the money go?"), stay legible
 *   when the label is long, and degrade to the text version above one-for-one.
 *   Same reasoning for the trend (columns over time) and the month's cumulative
 *   spend (a line, so the budget cap can be a reference line across it).
 *
 * - **Zero dependencies, so the PNG is rasterised here.** An RGBA buffer, simple
 *   primitives (rectangles, lines, a 5x7 bitmap font) and `deflateSync` for the
 *   IDAT. No canvas, no headless browser, no build step.
 *
 * - **Accented glyphs are composed, not transliterated.** "Alimentacao" inside a
 *   chart is a visible regression, so the font carries a base ASCII table and a
 *   handful of 5x2 accent marks that are blitted above (or below, for the
 *   cedilla) the base letter. Sixteen extra glyph definitions instead of sixteen
 *   whole letters, and it covers every accent Portuguese uses.
 *   Emoji are *not* rendered into the PNG — a bitmap font cannot — so the image
 *   labels a category by name and only the text version carries its emoji.
 *
 * - Every query filters `user_id`. Two people share this database and these
 *   charts are built from the same tables the reports are; a missing filter would
 *   put one person's spending in the other's picture.
 *
 * Language split (see `db.ts`): identifiers, comments and JSON keys are English.
 * Everything a person reads is Portuguese — including every label rendered
 * *inside* the image, because a person reads those too.
 *
 * Usage:
 *     node chart.ts --db PATH --user-id N --type category|trend|cumulative
 *                   [--period month] [--months 6] [--month YYYY-MM]
 *                   [--out DIR] [--no-png] [--json]
 *
 * `--user-id` is the internal `users.id`, not a Telegram id: authentication and
 * identity live in `fin.ts`, and this module is called from an already
 * authenticated context.
 */

import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_DB,
  FinError,
  addMonths,
  connect,
  currentVersion,
  formatMoney,
  isValidMonth,
  lastDayOfMonth,
  monthOf,
  periodRange,
  today,
  type Db,
} from "./db.ts";

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                               */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The standard CRC-32 table (polynomial 0xEDB88320), built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encodes an RGBA buffer as a PNG.
 *
 * Colour type 6 (truecolour with alpha), 8 bits per sample, filter type 0 on
 * every scanline — no filtering wins nothing on flat chart fills, and deflate
 * already collapses the long runs of identical pixels.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new FinError("Erro interno ao gerar a imagem do gráfico.");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0; // per-scanline filter byte
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), at + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Chart colours, fixed for a light surface.
 *
 * The image has no theme to follow — it is a file, and it sits on whatever
 * Telegram paints behind it — so it commits to the light surface. Two series at
 * most (spending, income), each directly labelled, which is what lets the aqua
 * carry meaning despite sitting under 3:1 against the surface.
 */
export const COLORS = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  inkMuted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  expense: "#2a78d6",
  income: "#1baf7a",
  over: "#d03b3b",
} as const;

type Rgba = readonly [number, number, number, number];

function rgba(hex: string, alpha = 1): Rgba {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    Math.round(alpha * 255),
  ];
}

/* -------------------------------------------------------------------------- */
/* Bitmap font                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A 5x7 font, one entry per glyph, seven rows of five cells separated by `/`.
 *
 * Written out as pixels rather than packed into bytes so a wrong glyph is
 * visible in the diff. Lowercase letters put their body in rows 2..6; the five
 * with descenders (g j p q y) are defined with the body at the top and are
 * blitted two rows lower, which is what gives them their tail without a taller
 * cell for everything else.
 */
const FONT: Record<string, string> = {
  " ": "...../...../...../...../...../...../.....",
  "0": ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  "1": "..#../.##../..#../..#../..#../..#../.###.",
  "2": ".###./#...#/....#/...#./..#../.#.../#####",
  "3": "#####/...#./..#../...#./....#/#...#/.###.",
  "4": "...#./..##./.#.#./#..#./#####/...#./...#.",
  "5": "#####/#..../####./....#/....#/#...#/.###.",
  "6": "..##./.#.../#..../####./#...#/#...#/.###.",
  "7": "#####/....#/...#./..#../.#.../.#.../.#...",
  "8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
  "9": ".###./#...#/#...#/.####/....#/...#./.##..",
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".###./#...#/#..../#..../#..../#...#/.###.",
  D: "####./#...#/#...#/#...#/#...#/#...#/####.",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".###./#...#/#..../#.###/#...#/#...#/.####",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: "#####/..#../..#../..#../..#../..#../#####",
  J: "..###/...#./...#./...#./...#./#..#./.##..",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
  N: "#...#/#...#/##..#/#.#.#/#..##/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..##/.####",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".####/#..../#..../.###./....#/....#/####.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  a: "...../...../.###./....#/.####/#...#/.####",
  b: "#..../#..../#.##./##..#/#...#/#...#/####.",
  c: "...../...../.###./#...#/#..../#...#/.###.",
  d: "....#/....#/.##.#/#..##/#...#/#...#/.####",
  e: "...../...../.###./#...#/#####/#..../.###.",
  f: "..##./.#..#/.#.../###../.#.../.#.../.#...",
  g: ".####/#...#/#...#/.####/....#/#...#/.###.",
  h: "#..../#..../#.##./##..#/#...#/#...#/#...#",
  i: "..#../...../.##../..#../..#../..#../.###.",
  j: "..#../...../..#../..#../..#../#.#../.##..",
  k: "#..../#..../#..#./#.#../##.../#.#../#..#.",
  l: ".##../..#../..#../..#../..#../..#../.###.",
  m: "...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#",
  n: "...../...../#.##./##..#/#...#/#...#/#...#",
  o: "...../...../.###./#...#/#...#/#...#/.###.",
  p: "####./#...#/#...#/####./#..../#..../#....",
  q: ".####/#...#/#...#/.####/....#/....#/....#",
  r: "...../...../#.##./##..#/#..../#..../#....",
  s: "...../...../.####/#..../.###./....#/####.",
  t: ".#.../.#.../###../.#.../.#.../.#..#/..##.",
  u: "...../...../#...#/#...#/#...#/#..##/.##.#",
  v: "...../...../#...#/#...#/#...#/.#.#./..#..",
  w: "...../...../#.#.#/#.#.#/#.#.#/#.#.#/.#.#.",
  x: "...../...../#...#/.#.#./..#../.#.#./#...#",
  y: "#...#/#...#/#...#/.####/....#/....#/.###.",
  z: "...../...../#####/...#./..#../.#.../#####",
  // Dotless i, so that í is the acute over a bare stem rather than over a dot.
  "ı": "...../...../.##../..#../..#../..#../.###.",
  ".": "...../...../...../...../...../.##../.##..",
  ",": "...../...../...../...../.##../..#../.#...",
  ":": "...../.##../.##../...../.##../.##../.....",
  ";": "...../.##../.##../...../.##../..#../.#...",
  "-": "...../...../...../#####/...../...../.....",
  // Em dash: the report style uses it between a label and its period.
  "—": "...../...../...../#####/...../...../.....",
  "/": "....#/...#./...#./..#../.#.../.#.../#....",
  "(": "...#./..#../.#.../.#.../.#.../..#../...#.",
  ")": ".#.../..#../...#./...#./...#./..#../.#...",
  "%": "##..#/##.#./...#./..#../.#.../.#.##/#..##",
  $: "..#../.####/#.#../.###./..#.#/####./..#..",
  "!": "..#../..#../..#../..#../..#../...../..#..",
  "?": ".###./#...#/....#/...#./..#../...../..#..",
  "+": "...../..#../..#../#####/..#../..#../.....",
  "=": "...../...../#####/...../#####/...../.....",
  "'": "..#../..#../...../...../...../...../.....",
  "·": "...../...../...../..#../...../...../.....",
  "…": "...../...../...../...../...../...../#.#.#",
  "º": ".###./#...#/.###./...../...../...../.....",
  "ª": ".###./....#/.####/#...#/.####/...../.....",
  "→": "...../..#../...#./#####/...#./..#../.....",
  "▲": "...../..#../.###./#####/...../...../.....",
};

/** Letters defined with the body at the top and drawn two rows lower. */
const DESCENDERS = new Set(["g", "j", "p", "q", "y"]);

/**
 * 5x2 accent marks, blitted above the base letter (below it, for the cedilla).
 *
 * Deliberately sparse: at this size a dense two-row mark sitting on a lowercase
 * letter merges with it — the first tilde tried here turned `ã` into something
 * that read as an `8`. One row of clear space below the mark, and only the
 * pixels that carry the shape.
 */
const MARKS: Record<string, string> = {
  acute: "...#./..#..",
  grave: ".#.../..#..",
  circ: "..#../.#.#.",
  tilde: ".#.##/#.#..",
  uml: ".#.#./.....",
  cedilla: "..#../.##..",
};

/**
 * Accented characters as base letter + mark.
 *
 * Composing them costs six small marks instead of a full glyph each, and covers
 * everything Portuguese writes: ç ã õ á é í ó ú â ê ô à, plus the ü and ñ that
 * turn up in borrowed words.
 */
const ACCENTED: Record<string, readonly [string, string]> = {
  á: ["a", "acute"], à: ["a", "grave"], â: ["a", "circ"], ã: ["a", "tilde"],
  ä: ["a", "uml"],
  é: ["e", "acute"], è: ["e", "grave"], ê: ["e", "circ"], ë: ["e", "uml"],
  í: ["ı", "acute"], ì: ["ı", "grave"], î: ["ı", "circ"],
  ï: ["ı", "uml"],
  ó: ["o", "acute"], ò: ["o", "grave"], ô: ["o", "circ"], õ: ["o", "tilde"],
  ö: ["o", "uml"],
  ú: ["u", "acute"], ù: ["u", "grave"], û: ["u", "circ"], ü: ["u", "uml"],
  ç: ["c", "cedilla"], ñ: ["n", "tilde"],
  Á: ["A", "acute"], À: ["A", "grave"], Â: ["A", "circ"], Ã: ["A", "tilde"],
  É: ["E", "acute"], Ê: ["E", "circ"], È: ["E", "grave"],
  Í: ["I", "acute"], Ì: ["I", "grave"],
  Ó: ["O", "acute"], Ô: ["O", "circ"], Õ: ["O", "tilde"], Ò: ["O", "grave"],
  Ú: ["U", "acute"], Ü: ["U", "uml"],
  Ç: ["C", "cedilla"], Ñ: ["N", "tilde"],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
/**
 * Rows above the base letter, reserved for accents.
 *
 * Three, not two: an uppercase letter fills its cell and wears its accent in the
 * top two rows, which leaves the third as the gap that keeps `Ã` from reading as
 * a solid block. Lowercase letters start two rows into their own cell, so their
 * accent drops by two and gets the same gap.
 */
const ACCENT_ROWS = 3;

function glyphRows(char: string): string[] | undefined {
  const g = FONT[char];
  return g ? g.split("/") : undefined;
}

/**
 * Splits a character into what has to be drawn for it.
 *
 * Anything the font does not know becomes `?`, so an unexpected character shows
 * up as a visible placeholder instead of silently shifting the rest of the line.
 */
function resolveChar(char: string): { base: string; mark?: string } {
  if (FONT[char]) return { base: char };
  const composed = ACCENTED[char];
  if (composed) return { base: composed[0], mark: composed[1] };
  const stripped = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (stripped !== char && FONT[stripped]) return { base: stripped };
  return { base: "?" };
}

/* -------------------------------------------------------------------------- */
/* Canvas                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An RGBA raster with the handful of primitives these charts need.
 *
 * Coordinates are *logical* pixels and get multiplied by `scale` on the way in,
 * so the layout code below reads at one size and the file comes out crisp at 2x
 * on a phone screen.
 */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly data: Uint8Array;

  constructor(logicalWidth: number, logicalHeight: number, scale = 2, background = COLORS.surface) {
    this.scale = scale;
    this.width = Math.round(logicalWidth * scale);
    this.height = Math.round(logicalHeight * scale);
    this.data = new Uint8Array(this.width * this.height * 4);
    const bg = rgba(background);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = bg[0];
      this.data[i + 1] = bg[1];
      this.data[i + 2] = bg[2];
      this.data[i + 3] = 255;
    }
  }

  /** Source-over blend of one device pixel; out-of-bounds writes are dropped. */
  private blend(x: number, y: number, color: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 4;
    const a = color[3] / 255;
    if (a >= 1) {
      this.data[at] = color[0];
      this.data[at + 1] = color[1];
      this.data[at + 2] = color[2];
      this.data[at + 3] = 255;
      return;
    }
    for (let c = 0; c < 3; c++) {
      this.data[at + c] = Math.round(color[c] * a + this.data[at + c] * (1 - a));
    }
    this.data[at + 3] = 255;
  }

  fillRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    const c = rgba(color, alpha);
    const x0 = Math.round(x * this.scale);
    const y0 = Math.round(y * this.scale);
    const x1 = Math.round((x + w) * this.scale);
    const y1 = Math.round((y + h) * this.scale);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.blend(px, py, c);
    }
  }

  /**
   * A bar with a rounded data-end and a square baseline end.
   *
   * `dir` says which side the value grows towards, so the same routine serves the
   * horizontal category bars and the vertical trend columns.
   */
  bar(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    dir: "right" | "up" = "right",
    radius = 4,
  ): void {
    const s = this.scale;
    const c = rgba(color);
    const x0 = Math.round(x * s);
    const y0 = Math.round(y * s);
    const x1 = Math.round((x + w) * s);
    const y1 = Math.round((y + h) * s);
    const r = Math.min(Math.round(radius * s), Math.floor((x1 - x0) / 2), Math.floor((y1 - y0) / 2));

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (r > 0) {
          // Distance from the rounded end's two corners.
          const nearEnd = dir === "right" ? px >= x1 - r : py < y0 + r;
          if (nearEnd) {
            const cx = dir === "right" ? x1 - r : px < x0 + r ? x0 + r : x1 - r - 1;
            const cy = dir === "right" ? (py < y0 + r ? y0 + r : y1 - r - 1) : y0 + r;
            const insideBand =
              dir === "right"
                ? py >= y0 + r && py < y1 - r
                : px >= x0 + r && px < x1 - r;
            if (!insideBand) {
              const dx = px - cx;
              const dy = py - cy;
              if (dx * dx + dy * dy > r * r) continue;
            }
          }
        }
        this.blend(px, py, c);
      }
    }
  }

  /** A straight line of `thickness` logical pixels. Bresenham, then a square pen. */
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    thickness = 1,
  ): void {
    const s = this.scale;
    const c = rgba(color);
    const t = Math.max(1, Math.round(thickness * s));
    let px = Math.round(x1 * s);
    let py = Math.round(y1 * s);
    const qx = Math.round(x2 * s);
    const qy = Math.round(y2 * s);
    const dx = Math.abs(qx - px);
    const dy = Math.abs(qy - py);
    const sx = px < qx ? 1 : -1;
    const sy = py < qy ? 1 : -1;
    let err = dx - dy;
    const half = Math.floor(t / 2);
    for (;;) {
      for (let oy = 0; oy < t; oy++) {
        for (let ox = 0; ox < t; ox++) this.blend(px - half + ox, py - half + oy, c);
      }
      if (px === qx && py === qy) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        px += sx;
      }
      if (e2 < dx) {
        err += dx;
        py += sy;
      }
    }
  }

  /** A filled circle, for the marker on the last point of a line. */
  dot(cx: number, cy: number, diameter: number, color: string): void {
    const s = this.scale;
    const c = rgba(color);
    const r = (diameter * s) / 2;
    const x0 = Math.round(cx * s);
    const y0 = Math.round(cy * s);
    const span = Math.ceil(r);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        if (dx * dx + dy * dy <= r * r) this.blend(x0 + dx, y0 + dy, c);
      }
    }
  }

  /** Width in logical pixels of `text` drawn at unit size `u`. */
  static measure(text: string, u: number): number {
    const chars = [...text].length;
    return chars === 0 ? 0 : chars * (GLYPH_W + 1) * u - u;
  }

  measure(text: string, u: number): number {
    return Canvas.measure(text, u);
  }

  /**
   * Draws text with the top of the accent band at `y`.
   *
   * `u` is the size of one font pixel in logical pixels: the letters are 7u tall
   * and advance 6u, so `u` is the one knob for "how big is this label".
   */
  text(x: number, y: number, text: string, color: string, u: number): number {
    const c = rgba(color);
    let cursor = x;
    for (const char of [...text]) {
      const { base, mark } = resolveChar(char);
      const rows = glyphRows(base);
      if (rows) {
        const drop = DESCENDERS.has(base) ? 2 : 0;
        const baseTop = y + (ACCENT_ROWS + drop) * u;
        this.blit(rows, cursor, baseTop, u, c);
        if (mark) {
          const markRows = MARKS[mark].split("/");
          if (mark === "cedilla") {
            this.blit(markRows, cursor, baseTop + GLYPH_H * u, u, c);
          } else {
            // Uppercase fills its cell from the top, so its accent sits at the
            // top of the band; lowercase leaves two rows free inside the cell and
            // wears the accent two rows lower. Either way one blank row remains
            // between the mark and the letter.
            const isUpper = base >= "A" && base <= "Z";
            this.blit(markRows, cursor, y + (isUpper ? 0 : 2) * u, u, c);
          }
        }
      }
      cursor += (GLYPH_W + 1) * u;
    }
    return cursor - u - x;
  }

  private blit(rows: string[], x: number, y: number, u: number, color: Rgba): void {
    const s = this.scale;
    const size = Math.max(1, Math.round(u * s));
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] === ".") continue;
        const px0 = Math.round((x + col * u) * s);
        const py0 = Math.round((y + row * u) * s);
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) this.blend(px0 + dx, py0 + dy, color);
        }
      }
    }
  }

  /** Same as `text`, but vertically centred on `cy` by the letter's cell. */
  textCentered(x: number, cy: number, text: string, color: string, u: number): number {
    return this.text(x, cy - (ACCENT_ROWS + GLYPH_H / 2) * u, text, color, u);
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

/**
 * Shortens a label to fit `maxWidth`, with an ellipsis.
 *
 * Long category names are normal ("Impostos e taxas", or whatever the user
 * renamed things to), and a label that runs into the bars is worse than a
 * truncated one.
 */
export function fitText(text: string, maxWidth: number, u: number): string {
  if (Canvas.measure(text, u) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join("").trimEnd()}…`;
    if (Canvas.measure(candidate, u) <= maxWidth) return candidate;
  }
  return "…";
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** `2026-08` -> `agosto/2026`, for a title someone reads. */
function monthLabel(month: string): string {
  const [year, mm] = month.split("-");
  return `${MONTH_NAMES[Number(mm) - 1]}/${year}`;
}

/** `2026-08` -> `08/26`, for an axis tick where space is the constraint. */
function monthTick(month: string): string {
  const [year, mm] = month.split("-");
  return `${mm}/${year.slice(2)}`;
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

/** `R$ 1.234,56` without the cents when they are zero — axis ticks are tight. */
function moneyShort(value: number): string {
  return value % 100 === 0 ? formatMoney(value).replace(",00", "") : formatMoney(value);
}

/** Round up to a clean axis maximum: 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10 × 10^n. */
function niceCeil(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const candidate = magnitude * step;
    if (value <= candidate) return Math.round(candidate);
  }
  return Math.round(magnitude * 10);
}

const pct = (part: number, whole: number): number =>
  whole ? Math.round((part * 1000) / whole) / 10 : 0;

/* -------------------------------------------------------------------------- */
/* Text charts                                                                */
/* -------------------------------------------------------------------------- */

const BAR_CELLS = 12;
const FILLED = "█"; // █
const TRACK = "░"; // ░

/**
 * One bar of block characters, always `cells` characters wide.
 *
 * Both characters come from the Unicode Block Elements range and share their
 * advance width in every font that has them, so a full bar and a nearly empty
 * one occupy the same space — which is what makes a column of these line up.
 * A non-zero value always gets at least one filled cell: rounding a real expense
 * down to an empty bar reads as "nothing was spent here", which is a lie.
 */
export function textBar(value: number, max: number, cells = BAR_CELLS): string {
  if (max <= 0 || value <= 0) return TRACK.repeat(cells);
  const filled = Math.min(cells, Math.max(1, Math.round((value / max) * cells)));
  return FILLED.repeat(filled) + TRACK.repeat(cells - filled);
}

/** Category names are free text; keep the inline chart to one line per row. */
function trim(label: string, max = 20): string {
  const chars = [...label];
  return chars.length <= max ? label : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

export interface CategorySlice {
  category: string;
  emoji: string | null;
  total_cents: number;
  total_fmt: string;
  count: number;
  pct: number;
}

/**
 * Spending per root category in a date range.
 *
 * Rolled up to the root the same way `fin.ts`'s `aggregate` does — a chart with
 * forty subcategories has no shape at all — and transfers are excluded, since
 * moving money between your own accounts is not spending.
 */
export function categorySeries(
  db: Db,
  userId: number,
  start: string,
  end: string,
): CategorySlice[] {
  const rows = db
    .prepare(
      "SELECT COALESCE(cp.name, c.name, 'Sem categoria') AS category," +
        "       COALESCE(cp.emoji, c.emoji)              AS emoji," +
        "       SUM(t.amount_cents)                      AS total," +
        "       COUNT(*)                                 AS n " +
        "FROM transactions t " +
        // The joins carry user_id as well. The rows are already scoped by
        // `t.user_id` below, so this is belt and braces — but a category name is
        // the one thing a join could pull in from the other person's taxonomy,
        // and defending it here costs nothing.
        "LEFT JOIN categories c  ON c.id  = t.category_id AND c.user_id  = t.user_id " +
        "LEFT JOIN categories cp ON cp.id = c.parent_id   AND cp.user_id = c.user_id " +
        "WHERE t.user_id = ? AND t.type = 'expense' AND t.date BETWEEN ? AND ? " +
        "GROUP BY category ORDER BY total DESC",
    )
    .all(userId, start, end) as {
    category: string;
    emoji: string | null;
    total: number;
    n: number;
  }[];

  const total = rows.reduce((acc, r) => acc + r.total, 0);
  return rows.map((r) => ({
    category: r.category,
    emoji: r.emoji,
    total_cents: r.total,
    total_fmt: formatMoney(r.total),
    count: r.n,
    pct: pct(r.total, total),
  }));
}

export interface MonthPoint {
  month: string;
  label: string;
  expenses_cents: number;
  expenses_fmt: string;
  income_cents: number;
  income_fmt: string;
}

/**
 * Expenses and income per month for the last `months` months, current included.
 *
 * Months with nothing in them are kept as zeroes: a gap in the sequence would
 * make the trend read as if the calendar had skipped a month.
 */
export function monthlySeries(
  db: Db,
  userId: number,
  months: number,
  reference?: string,
): MonthPoint[] {
  const ref = reference ?? today();
  const first = monthOf(addMonths(`${monthOf(ref)}-01`, -(months - 1)));
  const start = `${first}-01`;

  const rows = db
    .prepare(
      "SELECT substr(date,1,7) AS month, type, SUM(amount_cents) AS total " +
        "FROM transactions " +
        "WHERE user_id = ? AND type IN ('expense','income') AND date BETWEEN ? AND ? " +
        "GROUP BY month, type",
    )
    .all(userId, start, ref) as { month: string; type: string; total: number }[];

  const points: MonthPoint[] = [];
  for (let i = 0; i < months; i++) {
    const month = monthOf(addMonths(start, i));
    const expenses = rows.find((r) => r.month === month && r.type === "expense")?.total ?? 0;
    const income = rows.find((r) => r.month === month && r.type === "income")?.total ?? 0;
    points.push({
      month,
      label: monthTick(month),
      expenses_cents: expenses,
      expenses_fmt: formatMoney(expenses),
      income_cents: income,
      income_fmt: formatMoney(income),
    });
  }
  return points;
}

export interface CumulativePoint {
  date: string;
  day: number;
  spent_cents: number;
  cumulative_cents: number;
  cumulative_fmt: string;
}

export interface CumulativeData {
  month: string;
  points: CumulativePoint[];
  total_cents: number;
  cap_cents: number | null;
  days_in_month: number;
}

/**
 * The month's spending accumulated day by day, plus the monthly cap if set.
 *
 * The cap is the global budget (`category_id IS NULL`), with a month-specific row
 * winning over the recurring one — the same precedence `budgetStatuses` applies,
 * so the line drawn here is the number the alerts fire on.
 */
export function cumulativeSeries(db: Db, userId: number, month: string): CumulativeData {
  const [year, mm] = month.split("-").map(Number);
  const daysInMonth = lastDayOfMonth(year, mm);
  const start = `${month}-01`;
  const isCurrent = month === monthOf(today());
  const end = isCurrent ? today() : `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const lastDay = Number(end.slice(8, 10));

  const rows = db
    .prepare(
      "SELECT date, SUM(amount_cents) AS total FROM transactions " +
        "WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ? " +
        "GROUP BY date ORDER BY date",
    )
    .all(userId, start, end) as { date: string; total: number }[];

  const cap = db
    .prepare(
      "SELECT limit_cents FROM budgets " +
        "WHERE user_id = ? AND category_id IS NULL AND (month IS NULL OR month = ?) " +
        "ORDER BY (month IS NULL) LIMIT 1",
    )
    .get(userId, month) as { limit_cents: number } | undefined;

  const points: CumulativePoint[] = [];
  let running = 0;
  for (let day = 1; day <= lastDay; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const spent = rows.find((r) => r.date === date)?.total ?? 0;
    running += spent;
    points.push({
      date,
      day,
      spent_cents: spent,
      cumulative_cents: running,
      cumulative_fmt: formatMoney(running),
    });
  }

  return {
    month,
    points,
    total_cents: running,
    cap_cents: cap ? cap.limit_cents : null,
    days_in_month: daysInMonth,
  };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** Logical geometry of the category chart, shared by the renderer and its test. */
export const CATEGORY_LAYOUT = {
  width: 800,
  padding: 28,
  // padding + labelWidth stays clear of the axis line at barLeft - 6, so a
  // truncated label can never touch it. The column is wide enough for the
  // longest name the seeded taxonomy has ("Impostos e taxas") to survive whole.
  labelWidth: 200,
  barLeft: 242,
  barMax: 300,
  headerHeight: 104,
  rowHeight: 34,
  barThickness: 20,
  footerHeight: 26,
} as const;

/**
 * Bar widths in logical pixels, proportional to the largest value.
 *
 * Scaled to the largest slice rather than to the total, so the shape of the
 * comparison survives a month where one category took 70% of everything. A
 * non-zero value keeps a 3px stub for the same reason the text bar keeps a cell.
 */
export function barWidths(values: number[], maxWidth = CATEGORY_LAYOUT.barMax): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max <= 0 || v <= 0 ? 0 : Math.max(3, (v / max) * maxWidth)));
}

/* -------------------------------------------------------------------------- */
/* Renderers                                                                  */
/* -------------------------------------------------------------------------- */

const TITLE_U = 3;
const SUB_U = 2;
const LABEL_U = 2;
const TICK_U = 1.8;

function drawHeader(canvas: Canvas, title: string, subtitle: string, width: number): void {
  const pad = CATEGORY_LAYOUT.padding;
  canvas.text(pad, 22, fitText(title, width - 2 * pad, TITLE_U), COLORS.ink, TITLE_U);
  canvas.text(pad, 62, fitText(subtitle, width - 2 * pad, SUB_U), COLORS.inkMuted, SUB_U);
}

export function drawCategoryChart(
  slices: CategorySlice[],
  title: string,
  subtitle: string,
): Canvas {
  const L = CATEGORY_LAYOUT;
  const height = L.headerHeight + slices.length * L.rowHeight + L.footerHeight;
  const canvas = new Canvas(L.width, height);
  drawHeader(canvas, title, subtitle, L.width);

  const widths = barWidths(slices.map((s) => s.total_cents));
  // No gridlines: every bar carries its own value, and a direct label beats a
  // gridline the reader has to trace back to an axis.
  canvas.line(L.barLeft - 6, L.headerHeight - 8, L.barLeft - 6, height - L.footerHeight + 2, COLORS.axis, 1);

  // Values are right-aligned to the padding, and the whole column shrinks to
  // whatever fits: an unusually large amount ("R$ 1.234.567,89 (100%)") must not
  // run off the edge or into the longest bar.
  const values = slices.map((s) => `${s.total_fmt} (${Math.round(s.pct)}%)`);
  const available = L.width - L.padding - (L.barLeft + L.barMax + 12);
  const widest = values.reduce((a, b) => (Canvas.measure(b, 1) > Canvas.measure(a, 1) ? b : a), "");
  const valueU = Math.min(SUB_U, available / Canvas.measure(widest, 1));

  slices.forEach((slice, i) => {
    const top = L.headerHeight + i * L.rowHeight;
    const centre = top + L.rowHeight / 2;
    canvas.textCentered(
      L.padding,
      centre,
      fitText(slice.category, L.labelWidth, LABEL_U),
      COLORS.inkSecondary,
      LABEL_U,
    );
    canvas.bar(
      L.barLeft,
      centre - L.barThickness / 2,
      widths[i],
      L.barThickness,
      COLORS.expense,
      "right",
    );
    canvas.textCentered(
      L.width - L.padding - Canvas.measure(values[i], valueU),
      centre,
      values[i],
      COLORS.inkSecondary,
      valueU,
    );
  });

  return canvas;
}

export function drawTrendChart(
  points: MonthPoint[],
  title: string,
  subtitle: string,
  withIncome: boolean,
): Canvas {
  const width = 800;
  const height = 460;
  const canvas = new Canvas(width, height);
  drawHeader(canvas, title, subtitle, width);

  const plot = { left: 108, right: width - 28, top: 168, bottom: height - 56 };
  const maxValue = niceCeil(
    Math.max(
      1,
      ...points.map((p) => (withIncome ? Math.max(p.expenses_cents, p.income_cents) : p.expenses_cents)),
    ),
  );
  const plotW = plot.right - plot.left;
  const plotH = plot.bottom - plot.top;
  const yOf = (value: number) => plot.bottom - (value / maxValue) * plotH;

  // Four hairline gridlines with money ticks; the axis carries what the direct
  // labels do not.
  for (let i = 0; i <= 4; i++) {
    const value = (maxValue / 4) * i;
    const y = yOf(value);
    canvas.line(plot.left, y, plot.right, y, i === 0 ? COLORS.axis : COLORS.grid, 1);
    const tick = moneyShort(Math.round(value));
    canvas.textCentered(plot.left - 10 - Canvas.measure(tick, TICK_U), y, tick, COLORS.inkMuted, TICK_U);
  }

  if (withIncome) {
    // Two series, so a legend is mandatory: identity is never colour alone.
    const legendY = 108;
    canvas.fillRect(plot.left, legendY, 14, 14, COLORS.expense);
    canvas.textCentered(plot.left + 22, legendY + 7, "Gastos", COLORS.inkSecondary, TICK_U);
    const shift = plot.left + 22 + Canvas.measure("Gastos", TICK_U) + 28;
    canvas.fillRect(shift, legendY, 14, 14, COLORS.income);
    canvas.textCentered(shift + 22, legendY + 7, "Entradas", COLORS.inkSecondary, TICK_U);
  }

  const band = plotW / points.length;
  const thickness = Math.min(24, band * (withIncome ? 0.32 : 0.46));
  const biggest = points.reduce(
    (best, p, i) => (p.expenses_cents > points[best].expenses_cents ? i : best),
    0,
  );

  points.forEach((point, i) => {
    const centre = plot.left + band * (i + 0.5);
    // A 2px surface gap between adjacent bars, so the pair reads as a pair
    // without the fills touching.
    const expenseX = withIncome ? centre - thickness - 1 : centre - thickness / 2;
    const expenseH = plot.bottom - yOf(point.expenses_cents);
    if (expenseH > 0) {
      canvas.bar(expenseX, yOf(point.expenses_cents), thickness, expenseH, COLORS.expense, "up");
    }
    if (withIncome) {
      const incomeH = plot.bottom - yOf(point.income_cents);
      if (incomeH > 0) {
        canvas.bar(centre + 1, yOf(point.income_cents), thickness, incomeH, COLORS.income, "up");
      }
    }
    canvas.textCentered(
      centre - Canvas.measure(point.label, TICK_U) / 2,
      plot.bottom + 20,
      point.label,
      COLORS.inkMuted,
      TICK_U,
    );
    // Only the peak is labelled directly — a number on every column is noise.
    if (i === biggest && point.expenses_cents > 0) {
      const label = moneyShort(point.expenses_cents);
      const labelW = Canvas.measure(label, TICK_U);
      canvas.textCentered(
        // Kept inside the plot, so it never lands on top of the axis ticks.
        Math.min(plot.right - labelW, Math.max(plot.left, expenseX + thickness / 2 - labelW / 2)),
        yOf(point.expenses_cents) - 15,
        label,
        COLORS.inkSecondary,
        TICK_U,
      );
    }
  });

  return canvas;
}

export function drawCumulativeChart(
  data: CumulativeData,
  title: string,
  subtitle: string,
): Canvas {
  const width = 800;
  const height = 460;
  const canvas = new Canvas(width, height);
  drawHeader(canvas, title, subtitle, width);

  const plot = { left: 108, right: width - 28, top: 130, bottom: height - 56 };
  const cap = data.cap_cents;
  const maxValue = niceCeil(Math.max(1, data.total_cents, cap ?? 0) * 1.05);
  const plotW = plot.right - plot.left;
  const plotH = plot.bottom - plot.top;
  const lastDay = data.points.length;
  const xOf = (day: number) =>
    plot.left + (lastDay <= 1 ? 0 : ((day - 1) / (data.days_in_month - 1)) * plotW);
  const yOf = (value: number) => plot.bottom - (value / maxValue) * plotH;

  for (let i = 0; i <= 4; i++) {
    const value = (maxValue / 4) * i;
    const y = yOf(value);
    canvas.line(plot.left, y, plot.right, y, i === 0 ? COLORS.axis : COLORS.grid, 1);
    const tick = moneyShort(Math.round(value));
    canvas.textCentered(plot.left - 10 - Canvas.measure(tick, TICK_U), y, tick, COLORS.inkMuted, TICK_U);
  }

  // The area under the line, at low alpha: it is what makes "how much of the
  // month is already spent" legible before you read a single number. Filled
  // column by column with the y interpolated along the segment, so the edge
  // follows the line instead of stepping under it.
  const columnStep = 1 / canvas.scale;
  for (let i = 1; i < data.points.length; i++) {
    const x0 = xOf(data.points[i - 1].day);
    const x1 = xOf(data.points[i].day);
    const y0 = yOf(data.points[i - 1].cumulative_cents);
    const y1 = yOf(data.points[i].cumulative_cents);
    for (let x = x0; x < x1; x += columnStep) {
      const y = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
      canvas.fillRect(x, y, columnStep, plot.bottom - y, COLORS.expense, 0.12);
    }
  }

  for (let i = 1; i < data.points.length; i++) {
    const previous = data.points[i - 1];
    const current = data.points[i];
    // Above the cap the line turns red: the overshoot is the thing to see.
    const colour = cap !== null && current.cumulative_cents > cap ? COLORS.over : COLORS.expense;
    canvas.line(
      xOf(previous.day),
      yOf(previous.cumulative_cents),
      xOf(current.day),
      yOf(current.cumulative_cents),
      colour,
      2,
    );
  }

  if (cap !== null) {
    const y = yOf(cap);
    canvas.line(plot.left, y, plot.right, y, COLORS.over, 1.5);
    const label = `Limite ${moneyShort(cap)}`;
    canvas.textCentered(plot.right - Canvas.measure(label, TICK_U), y - 14, label, COLORS.over, TICK_U);
  }

  const last = data.points[data.points.length - 1];
  if (last) {
    const overCap = cap !== null && last.cumulative_cents > cap;
    canvas.dot(xOf(last.day), yOf(last.cumulative_cents), 9, overCap ? COLORS.over : COLORS.expense);
    const label = moneyShort(last.cumulative_cents);
    const labelW = Canvas.measure(label, SUB_U);
    const x = Math.min(plot.right - labelW, Math.max(plot.left, xOf(last.day) - labelW / 2));
    canvas.textCentered(x, yOf(last.cumulative_cents) - 20, label, COLORS.ink, SUB_U);
  }

  // Day ticks every five days, plus the last day of the month.
  for (let day = 1; day <= data.days_in_month; day += 5) {
    const label = `${day}`;
    canvas.textCentered(
      xOf(day) - Canvas.measure(label, TICK_U) / 2,
      plot.bottom + 20,
      label,
      COLORS.inkMuted,
      TICK_U,
    );
  }
  canvas.textCentered(plot.left, plot.bottom + 42, "dia do mês", COLORS.inkMuted, TICK_U);

  return canvas;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export type ChartType = "category" | "trend" | "cumulative";

export const CHART_TYPES: readonly ChartType[] = ["category", "trend", "cumulative"];

export interface ChartOptions {
  /** Named period for `category` (anything `periodRange` accepts). */
  period?: string;
  /** How many months `trend` covers, current included. 2..24. */
  months?: number;
  /** `YYYY-MM` for `cumulative`. Defaults to the current month. */
  month?: string;
  /** Where the PNG goes. Defaults to `charts/` beside the database. */
  out?: string;
  /** Used to find that default directory. */
  dbPath?: string;
  /** Set false for the text chart only — no file is written. */
  png?: boolean;
  /** Include the numbers in the result, for a caller that wants them. */
  withData?: boolean;
}

export interface ChartResult {
  type: ChartType;
  title: string;
  subtitle: string;
  /** The inline version: what the agent sends as a message. */
  text: string;
  /** The PNG, or null when there is nothing to draw. */
  file: string | null;
  /** Device pixels, matching the PNG's IHDR. */
  width: number | null;
  height: number | null;
  /** True when the period holds no spending; `text` then explains it. */
  empty: boolean;
  data?: unknown;
}

/** How many bars before the tail is folded into "Outras". */
const MAX_SLICES = 9;

function chartsDir(options: ChartOptions): string {
  if (options.out) return options.out;
  return join(dirname(resolve(options.dbPath ?? DEFAULT_DB)), "charts");
}

/**
 * Writes the PNG.
 *
 * `u<id>` in the filename for the same reason `export` uses it: both people
 * write into the same directory, and a shared name would attach one person's
 * chart to the other's chat.
 */
function writePng(canvas: Canvas, userId: number, type: ChartType, stamp: string, options: ChartOptions): string {
  const dir = chartsDir(options);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `tally-u${userId}-${type}-${stamp}.png`);
  writeFileSync(path, canvas.toPng());
  return path;
}

function emptyResult(
  type: ChartType,
  title: string,
  subtitle: string,
  message: string,
): ChartResult {
  return {
    type,
    title,
    subtitle,
    text: `${title}\n${subtitle}\n\n${message}`,
    file: null,
    width: null,
    height: null,
    empty: true,
  };
}

/** Spending by category over a period. */
export function chartCategory(
  db: Db,
  userId: number,
  options: ChartOptions = {},
): ChartResult {
  const period = periodRange(options.period ?? "month");
  const all = categorySeries(db, userId, period.start, period.end);
  const total = all.reduce((acc, s) => acc + s.total_cents, 0);
  const title = `📊 Gastos por categoria — ${period.label}`;
  const subtitle = `${shortDate(period.start)} a ${shortDate(period.end)}`;

  if (!all.length || total <= 0) {
    return emptyResult(
      "category",
      title,
      subtitle,
      "Nenhum gasto registrado neste período — sem dados para o gráfico.",
    );
  }

  // The tail becomes one "Outras" bar instead of a dozen slivers, and it keeps
  // the percentages adding up to the whole.
  let slices = all;
  if (all.length > MAX_SLICES) {
    const head = all.slice(0, MAX_SLICES - 1);
    const tail = all.slice(MAX_SLICES - 1);
    const tailTotal = tail.reduce((acc, s) => acc + s.total_cents, 0);
    slices = [
      ...head,
      {
        category: `Outras (${tail.length})`,
        emoji: "•",
        total_cents: tailTotal,
        total_fmt: formatMoney(tailTotal),
        count: tail.reduce((acc, s) => acc + s.count, 0),
        pct: pct(tailTotal, total),
      },
    ];
  }

  const max = slices[0].total_cents;
  const lines = [
    `*${title}*`,
    `_${subtitle} · total ${formatMoney(total)}_`,
    "",
    ...slices.map(
      (s) =>
        `${textBar(s.total_cents, max)} ${s.emoji ?? "•"} ${trim(s.category)} — ` +
        `${s.total_fmt} (${Math.round(s.pct)}%)`,
    ),
  ];

  const canvas = drawCategoryChart(
    slices,
    `Gastos por categoria — ${period.label}`,
    `${shortDate(period.start)} a ${shortDate(period.end)} · total ${formatMoney(total)}`,
  );

  const file =
    options.png === false
      ? null
      : writePng(canvas, userId, "category", `${period.start}-a-${period.end}`, options);

  return {
    type: "category",
    title,
    subtitle,
    text: lines.join("\n"),
    file,
    width: canvas.width,
    height: canvas.height,
    empty: false,
    ...(options.withData ? { data: { period, total_cents: total, slices } } : {}),
  };
}

/** Expenses month over month, income alongside when there is any. */
export function chartTrend(db: Db, userId: number, options: ChartOptions = {}): ChartResult {
  const months = options.months ?? 6;
  if (!Number.isInteger(months) || months < 2 || months > 24) {
    throw new FinError("Use entre 2 e 24 meses no gráfico de evolução.");
  }

  const points = monthlySeries(db, userId, months);
  const title = `📈 Evolução dos gastos — últimos ${months} meses`;
  const totalExpenses = points.reduce((acc, p) => acc + p.expenses_cents, 0);
  const totalIncome = points.reduce((acc, p) => acc + p.income_cents, 0);
  const subtitle = `${monthLabel(points[0].month)} a ${monthLabel(points[points.length - 1].month)} · mês atual parcial`;

  if (totalExpenses <= 0 && totalIncome <= 0) {
    return emptyResult(
      "trend",
      title,
      subtitle,
      `Nenhum lançamento nos últimos ${months} meses — sem dados para o gráfico.`,
    );
  }

  const withIncome = totalIncome > 0;
  const max = Math.max(...points.map((p) => p.expenses_cents));
  const average = Math.round(totalExpenses / months);
  const lines = [
    `*${title}*`,
    `_${subtitle}_`,
    "",
    ...points.map(
      (p) => `${textBar(p.expenses_cents, max)} ${p.label} — ${p.expenses_fmt}`,
    ),
    "",
    `Média mensal: *${formatMoney(average)}*`,
  ];
  if (withIncome) lines.push(`Entradas no período: ${formatMoney(totalIncome)}`);

  const canvas = drawTrendChart(
    points,
    `Evolução dos gastos — últimos ${months} meses`,
    subtitle,
    withIncome,
  );

  const file =
    options.png === false
      ? null
      : writePng(
          canvas,
          userId,
          "trend",
          `${points[0].month}-a-${points[points.length - 1].month}`,
          options,
        );

  return {
    type: "trend",
    title,
    subtitle,
    text: lines.join("\n"),
    file,
    width: canvas.width,
    height: canvas.height,
    empty: false,
    ...(options.withData
      ? { data: { points, total_expenses_cents: totalExpenses, average_cents: average } }
      : {}),
  };
}

/** The current month's spending, accumulated, against the budget cap. */
export function chartCumulative(
  db: Db,
  userId: number,
  options: ChartOptions = {},
): ChartResult {
  const month = options.month ?? monthOf(today());
  if (!isValidMonth(month)) throw new FinError(`Mês inválido: ${month}. Use YYYY-MM.`);

  const data = cumulativeSeries(db, userId, month);
  const title = `📅 Gasto acumulado — ${monthLabel(month)}`;
  const cap = data.cap_cents;
  const subtitle =
    cap !== null
      ? `Limite do mês ${formatMoney(cap)} · ${Math.round(pct(data.total_cents, cap))}% usado`
      : `${data.points.length} dia(s) no período · sem limite definido`;

  if (data.total_cents <= 0) {
    return emptyResult(
      "cumulative",
      title,
      subtitle,
      `Nenhum gasto registrado em ${monthLabel(month)} — sem dados para o gráfico.`,
    );
  }

  // Scale to the cap when there is one, so a full bar means "you are at the
  // limit" rather than "you are at your own maximum".
  const scale = Math.max(data.total_cents, cap ?? 0);

  // At most six sampled days: one line per day would be a 31-line message.
  const step = Math.max(1, Math.ceil(data.points.length / 6));
  const sampled: CumulativePoint[] = [];
  for (let i = step - 1; i < data.points.length; i += step) sampled.push(data.points[i]);
  const last = data.points[data.points.length - 1];
  if (sampled[sampled.length - 1]?.day !== last.day) sampled.push(last);

  const lines = [
    `*${title}*`,
    `_${subtitle}_`,
    "",
    ...sampled.map((p) => {
      const share = cap !== null ? ` (${Math.round(pct(p.cumulative_cents, cap))}%)` : "";
      return `${textBar(p.cumulative_cents, scale)} dia ${String(p.day).padStart(2, "0")} — ${p.cumulative_fmt}${share}`;
    }),
  ];
  if (cap !== null) {
    lines.push("");
    lines.push(
      data.total_cents > cap
        ? `🔴 Você passou do limite em *${formatMoney(data.total_cents - cap)}*.`
        : `🟢 Ainda restam *${formatMoney(cap - data.total_cents)}* do limite.`,
    );
  }

  const canvas = drawCumulativeChart(
    data,
    `Gasto acumulado — ${monthLabel(month)}`,
    cap !== null
      ? `Limite ${formatMoney(cap)} · ${Math.round(pct(data.total_cents, cap))}% usado`
      : `Total ${formatMoney(data.total_cents)} · sem limite definido`,
  );

  const file =
    options.png === false ? null : writePng(canvas, userId, "cumulative", month, options);

  return {
    type: "cumulative",
    title,
    subtitle,
    text: lines.join("\n"),
    file,
    width: canvas.width,
    height: canvas.height,
    empty: false,
    ...(options.withData ? { data } : {}),
  };
}

/**
 * The single entry point a caller wires up.
 *
 * `userId` is the internal `users.id`; the caller is responsible for having
 * authenticated it.
 */
export function buildChart(
  db: Db,
  userId: number,
  type: string,
  options: ChartOptions = {},
): ChartResult {
  switch (type) {
    case "category":
      return chartCategory(db, userId, options);
    case "trend":
      return chartTrend(db, userId, options);
    case "cumulative":
      return chartCumulative(db, userId, options);
    default:
      throw new FinError(
        `Tipo de gráfico inválido: ${type}. Use ${CHART_TYPES.join(", ")}.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `Gráficos do Tally. Sempre imprime JSON.

  node chart.ts --db PATH --user-id N --type category|trend|cumulative
                [--period month] [--months 6] [--month YYYY-MM]
                [--out DIR] [--no-png] [--json]

--user-id é o users.id interno (não o id do Telegram): a autenticação é feita
em fin.ts, antes de chegar aqui.

  category    gastos por categoria no período (--period)
  trend       gastos mês a mês (--months, 2..24)
  cumulative  gasto acumulado do mês com o limite como referência (--month)
`;

export function main(argv: string[]): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        db: { type: "string" },
        "user-id": { type: "string" },
        type: { type: "string" },
        period: { type: "string" },
        months: { type: "string" },
        month: { type: "string" },
        out: { type: "string" },
        "no-png": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }) as { values: Record<string, string | boolean | undefined> });
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: `Opções inválidas: ${(e as Error).message}` }, null, 2)}\n`,
    );
    return 1;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const str = (key: string): string | undefined =>
    typeof values[key] === "string" ? (values[key] as string) : undefined;

  let db: Db | undefined;
  try {
    const rawUser = str("user-id");
    if (!rawUser || !/^\d+$/.test(rawUser)) {
      throw new FinError("Informe --user-id (o id interno do usuário).");
    }
    const userId = Number(rawUser);
    const type = str("type") ?? "category";
    const months = str("months");
    if (months !== undefined && !/^\d+$/.test(months)) {
      throw new FinError("--months precisa ser um número inteiro.");
    }

    const dbPath = str("db") ?? process.env.TALLY_DB ?? DEFAULT_DB;
    db = connect(dbPath);

    // Only on this path: called from `fin.ts` the schema is already there and the
    // user has been through the auth gate. Standing on its own, the CLI has to
    // say what is wrong instead of surfacing "no such table: transactions".
    // It migrates nothing — a chart is a read.
    if (currentVersion(db) < CURRENT_SCHEMA_VERSION) {
      throw new FinError(
        "O banco de dados ainda não foi inicializado. Rode `fin.ts init` antes.",
      );
    }
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
      throw new FinError(`Não existe usuário com o id interno ${userId}.`);
    }

    const result = buildChart(db, userId, type, {
      period: str("period"),
      months: months === undefined ? undefined : Number(months),
      month: str("month"),
      out: str("out"),
      dbPath,
      png: values["no-png"] !== true,
      withData: values.json === true,
    });

    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const message =
      e instanceof FinError
        ? e.message
        : `Erro inesperado ao gerar o gráfico: ${(e as Error).message ?? String(e)}`;
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
