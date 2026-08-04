#!/usr/bin/env node
/**
 * Statement import — OFX and CSV files into the ledger.
 *
 * Filling months of history by hand is what makes people give up on a finance
 * bot in week one. Every Brazilian bank exports OFX and Nubank exports CSV, so
 * those are the two formats here.
 *
 * Decisions worth knowing before touching this file:
 *
 * - **Reading the file is the easy part; not duplicating is the hard part.** A
 *   person will re-send the same statement, or two statements that overlap by a
 *   few days. There is no column in the schema for an external id, so the
 *   identity of an imported row is written into `note` as a marker (see
 *   `MARKER_*` below) and queried back with LIKE. Two markers per row:
 *   the bank's own `FITID` when the file has one, and always a content
 *   fingerprint. Having both is what lets an OFX and a CSV of the same period
 *   recognise each other.
 *
 * - **Duplicate detection is count-based, never boolean.** Two identical coffees
 *   on the same day for the same amount are two coffees, not a duplicate. So the
 *   rule is: if the file holds M rows with the same fingerprint and the ledger
 *   already holds N, the first N are duplicates and the remaining M − N are new.
 *   Re-importing the same file gives M = N and therefore imports nothing;
 *   importing a file with one extra identical coffee imports exactly one.
 *
 * - **Two phases, never a blind import.** `previewImport` only reads: it parses,
 *   categorises, marks each row new/duplicate/invalid and returns a Portuguese
 *   summary for a person to approve. `applyImport` inserts the new rows inside a
 *   single transaction, so a failure halfway leaves the ledger untouched.
 *
 * - **Preview and apply agree because the derivation is pure.** Apply re-reads
 *   the same file and re-derives the same decisions rather than trusting a
 *   payload the model could have edited. The preview's `token` is a digest of
 *   everything that came out of the file (bytes, format, sign convention,
 *   parsed rows, guessed categories); apply verifies it when given one. What the
 *   token deliberately does *not* cover is the ledger's own state — if a row was
 *   inserted between preview and apply, apply must skip it, and that is a
 *   feature of the dedup rule rather than a mismatch.
 *
 * - **Categorisation is conservative.** `Outros` with the bank's description
 *   intact beats a confident wrong guess, because a wrong category silently
 *   corrupts every future report. Each row carries a confidence so the preview
 *   can flag the shaky ones for the person to fix. Import never *creates* a
 *   category: a statement full of merchant gibberish would grow a tree nobody
 *   asked for.
 *
 * - **Nothing crosses between the two people sharing this database.** Every
 *   statement here filters or sets `user_id`, and the marker digests have the
 *   user id mixed in, so one person's rows cannot even accidentally satisfy the
 *   other's dedup query.
 *
 * Language split, as everywhere in this codebase: identifiers, comments and JSON
 * keys English; anything the user reads Portuguese.
 *
 * Usage:
 *     node statement-import.ts --db PATH --user-id N --file PATH \
 *         [--format ofx|csv|auto] [--account NAME] [--sign auto|debit-negative|debit-positive] \
 *         [--token TOKEN] [--apply] [--json]
 */

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  FinError,
  connect,
  currentVersion,
  formatMoney,
  fullCategoryName,
  migrate,
  normalize,
  now,
  parseAmount,
  parseDate,
  resolveAccount,
  resolveCategory,
  transaction,
  type Db,
} from "./db.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type StatementFormat = "ofx" | "csv";
export type FormatOption = StatementFormat | "auto";
/** Which sign the file uses for money leaving the account. */
export type SignConvention = "debit-negative" | "debit-positive";
export type SignOption = SignConvention | "auto";
export type Confidence = "high" | "medium" | "low";
export type EntryType = "expense" | "income";
export type RowStatus = "new" | "duplicate" | "invalid";

/** One line of the file, after parsing but before any ledger knowledge. */
export interface StatementEntry {
  /** Position in the file, 1-based. Stable, and what the preview refers to. */
  index: number;
  /** `YYYY-MM-DD`, or null when the line had no readable date. */
  date: string | null;
  /** Always positive; the direction lives in `type`. */
  amount_cents: number | null;
  type: EntryType | null;
  description: string;
  /** The bank's own stable id: OFX `FITID`, or Nubank's `Identificador`. */
  external_id: string | null;
  /** OFX `ACCTID` — scopes `external_id`, which is only unique per account. */
  account_ref: string | null;
  /** OFX `TRNTYPE`, kept for the record. */
  raw_type: string | null;
  /** Portuguese reason the line cannot be imported, when it cannot. */
  invalid_reason: string | null;
}

export interface ParsedStatement {
  format: StatementFormat;
  encoding: string;
  sign_convention: SignConvention;
  /** How the sign convention was decided, for the report. */
  sign_source: "option" | "header" | "default";
  account_ref: string | null;
  statement_kind: "bank" | "card" | "unknown";
  entries: StatementEntry[];
  /** Portuguese notes about the file as a whole. */
  warnings: string[];
}

export interface CategoryGuess {
  /** A category name from the seeded tree, in Portuguese. */
  category: string;
  confidence: Confidence;
  /** The keyword that fired, for debugging a bad guess. */
  matched: string | null;
}

export interface ImportRow {
  index: number;
  status: RowStatus;
  date: string | null;
  description: string;
  amount_cents: number | null;
  amount_fmt: string | null;
  type: EntryType | null;
  category: string | null;
  full_category: string | null;
  confidence: Confidence | null;
  /** Why it was skipped: Portuguese, shown to the user. */
  reason: string | null;
  /** Something the person should look at before approving. */
  warning: string | null;
}

export interface ImportOptions {
  /** Path to the statement. Ignored when `bytes` is given. */
  file?: string;
  /** The file's contents, for callers that already have them (and for tests). */
  bytes?: Buffer;
  /** A name for `bytes`, used only for format sniffing and the report. */
  name?: string;
  format?: FormatOption;
  account?: string;
  sign?: SignOption;
  /** A token from a previous preview; refuses to apply when it disagrees. */
  token?: string;
  /** Cap on rows detailed in the response. 0 means no cap. */
  maxRows?: number;
}

export interface ImportPreview {
  applied: false;
  file: string;
  format: StatementFormat;
  encoding: string;
  sign_convention: SignConvention;
  statement_kind: "bank" | "card" | "unknown";
  account: string | null;
  token: string;
  parsed_count: number;
  new_count: number;
  duplicate_count: number;
  invalid_count: number;
  low_confidence_count: number;
  new_expenses_cents: number;
  new_expenses_fmt: string;
  new_income_cents: number;
  new_income_fmt: string;
  net_fmt: string;
  date_start: string | null;
  date_end: string | null;
  rows: ImportRow[];
  rows_truncated: boolean;
  warnings: string[];
  text: string;
}

export interface CreatedRow {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  amount_fmt: string;
  type: EntryType;
  full_category: string;
}

export interface ImportResult {
  applied: true;
  file: string;
  format: StatementFormat;
  account: string | null;
  token: string;
  parsed_count: number;
  created_count: number;
  duplicate_count: number;
  invalid_count: number;
  expenses_cents: number;
  expenses_fmt: string;
  income_cents: number;
  income_fmt: string;
  date_start: string | null;
  date_end: string | null;
  ids: number[];
  created: CreatedRow[];
  created_truncated: boolean;
  warnings: string[];
  text: string;
}

/* -------------------------------------------------------------------------- */
/* Markers — how an imported row remembers where it came from                  */
/* -------------------------------------------------------------------------- */

/**
 * The note format, documented once because everything else depends on it.
 *
 * An imported row's `note` is exactly one or two markers, in this order:
 *
 *     [imp:fitid:<16 hex>][imp:hash:<16 hex>]
 *
 * - `fitid` is present only when the file carried a bank-issued id, and is
 *   `sha256("v1|" + userId + "|" + acctId + "|" + fitid)` truncated to 16 hex
 *   characters. The account id comes from the file (OFX `ACCTID`) because a
 *   FITID is only unique within an account.
 * - `hash` is always present: `sha256("v1|" + userId + "|" + date + "|" +
 *   amountCents + "|" + type + "|" + normalisedDescription)`, also 16 hex.
 *
 * Hashing instead of storing raw values keeps the note short, keeps it free of
 * characters that would break a LIKE pattern, and — because the user id is
 * inside the digest — makes it structurally impossible for one person's rows to
 * match the other's marker even if a `user_id` filter were ever forgotten.
 *
 * 16 hex characters is 64 bits. At the scale of one household's ledger the
 * collision probability is far below the probability of the bank sending a wrong
 * statement.
 */
const MARKER_FITID = "[imp:fitid:";
const MARKER_HASH = "[imp:hash:";
const DIGEST_LENGTH = 16;

/** `source` for rows that came from a file rather than from the chat. */
export const IMPORT_SOURCE = "import";

function digest(...parts: (string | number)[]): string {
  return createHash("sha256")
    .update(["v1", ...parts.map(String)].join("|"), "utf8")
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

export function fitidMarker(userId: number, accountRef: string | null, fitid: string): string {
  return `${MARKER_FITID}${digest(userId, accountRef ?? "", fitid)}]`;
}

export function hashMarker(
  userId: number,
  date: string,
  amountCents: number,
  type: EntryType,
  description: string,
): string {
  return `${MARKER_HASH}${digest(userId, date, amountCents, type, normalizeDescription(description))}]`;
}

/* -------------------------------------------------------------------------- */
/* Description normalisation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reduces a bank description to the part that identifies the transaction.
 *
 * The same purchase comes back worded differently from one export to the next,
 * so everything volatile has to go before it can be fingerprinted. What is
 * stripped, and why:
 *
 * - accents, case and repeated whitespace (`normalize` from `db.ts`, plus a
 *   collapse) — the same merchant arrives as "PADARIA SÃO JOSÉ" and
 *   "Padaria Sao Jose";
 * - payment-processor prefixes glued on with a star: `PAG*`, `MP*`, `PICPAY*`,
 *   `CIELO*`… — the same merchant reaches the statement through whichever
 *   acquirer happened to route it;
 * - instalment counters: `PARCELA 03/12`, `PARC 3 DE 12`, a trailing `03/12` —
 *   the counter belongs to the purchase, not to this line, and one bank writes
 *   it three different ways;
 * - card-network noise: `COMPRA COM CARTAO`, `COMPRA NO DEBITO`, `COMPRA CARTAO`;
 * - terminal, authorisation and document identifiers: `TERM 0042`, `NSU 123456`,
 *   `AUT 998877`, `DOC 12345`, `CV 8899`, `REF 4455`;
 * - CPF/CNPJ, and any bare run of four or more digits (store numbers, sequence
 *   numbers, years) — these are exactly the parts that change between exports;
 * - remaining punctuation, turned into spaces.
 *
 * What is deliberately *kept*: the merchant name, "PIX", "TED", "SAQUE" and any
 * short number (a "99" or a "24h" is part of the name). If stripping empties the
 * string, the accent-free original is used instead — an empty fingerprint would
 * make every unnameable line look like the same transaction.
 */
export function normalizeDescription(text: string): string {
  const original = normalize(String(text ?? "")).replace(/\s+/g, " ").trim();
  let s = original;

  // Acquirer / wallet prefixes. The star is the signal, so this cannot eat a
  // merchant name that merely starts with the same letters.
  s = s.replace(
    /^(mp|pag|pags|pagseguro|picpay|cielo|rede|getnet|stone|sumup|pp|iz|infinitepay|mercadopago|mercpago)\*+\s*/,
    "",
  );

  // Card-network wording the bank adds around the merchant.
  s = s.replace(
    /\b(compra com cartao(?: de (?:credito|debito))?|compra no (?:credito|debito)|compra cartao|cartao de (?:credito|debito))\b/g,
    " ",
  );

  // Instalment counters, in the shapes Brazilian banks actually emit.
  s = s.replace(/\b(parcela|parc|parcelamento|prestacao)\s*n?o?\s*\d{1,3}\s*(?:\/|de)\s*\d{1,3}\b/g, " ");
  s = s.replace(/\b(parcela|parc)\s*\d{1,3}\b/g, " ");
  s = s.replace(/\b\d{1,2}\s*\/\s*\d{1,2}\s*$/, " ");

  // Terminal / authorisation / document references.
  s = s.replace(/\b(term(inal)?|nsu|aut(orizacao)?|doc|ted|cv|ref|seq|id|est)\s*n?o?[.:]?\s*\d+\b/g, " ");
  s = s.replace(/\bpos\s*\d+\b/g, " ");

  // Documents.
  s = s.replace(/\b\d{3}\.\d{3}\.\d{3}-?\d{2}\b/g, " ");
  s = s.replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-?\d{2}\b/g, " ");

  // Dates the bank repeats inside the description.
  s = s.replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, " ");

  // Any long bare number left: store code, sequence, year.
  s = s.replace(/\b\d{4,}\b/g, " ");

  // Whatever punctuation survived.
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

  return s || original;
}

/* -------------------------------------------------------------------------- */
/* Categorisation                                                             */
/* -------------------------------------------------------------------------- */

interface Rule {
  /** Category name as seeded in the tree — see `references/categories.md`. */
  category: string;
  confidence: Confidence;
  /** Which direction this rule may fire for. */
  types: readonly EntryType[];
  /** Normalised (lowercase, accent-free) keywords. */
  keywords: readonly string[];
  /** Portuguese note attached to the row when this rule fires. */
  warning?: string;
}

const EXPENSE = ["expense"] as const;
const INCOME = ["income"] as const;
const BOTH = ["expense", "income"] as const;

/**
 * Merchant knowledge, transcribed from `references/categories.md` and extended
 * with the names that actually show up on a Brazilian statement (the user types
 * "ifood", the bank writes "IFD*IFOOD.COM AGENCIA DE REST").
 *
 * `high` is a brand or a word that means one thing only. `medium` is a generic
 * word that is usually right. Anything shakier is left to `Outros` on purpose:
 * a wrong category is worse than an obviously missing one, because nobody goes
 * back to fix a report that merely looks plausible.
 *
 * The longest matching keyword wins, so "uber eats" beats "uber" and
 * "vivo fibra" beats "vivo".
 */
const RULES: readonly Rule[] = [
  // Alimentação
  { category: "Delivery", confidence: "high", types: EXPENSE, keywords: ["ifood", "ifd", "rappi", "uber eats", "ubereats", "aiqfome", "ze delivery", "zedelivery", "delivery much"] },
  { category: "Delivery", confidence: "medium", types: EXPENSE, keywords: ["delivery"] },
  { category: "Mercado", confidence: "high", types: EXPENSE, keywords: ["carrefour", "pao de acucar", "paodeacucar", "assai", "atacadao", "sams club", "hortifruti", "zona sul", "st marche", "sonda supermercados", "tenda atacado", "oxxo", "supermercado", "super mercado", "mercearia", "emporio"] },
  { category: "Mercado", confidence: "medium", types: EXPENSE, keywords: ["mercado", "compras do mes"] },
  { category: "Restaurante", confidence: "high", types: EXPENSE, keywords: ["restaurante", "churrascaria", "pizzaria", "hamburgueria", "outback", "madero", "mcdonalds", "burger king", "subway", "habibs", "giraffas", "spoleto", "coco bambu", "china in box", "temakeria", "dominos", "pizza hut", "kfc", "bobs", "rodizio"] },
  { category: "Restaurante", confidence: "medium", types: EXPENSE, keywords: ["almoco", "janta", "jantar", "comi fora", "sushi", "lanchonete"] },
  { category: "Café", confidence: "high", types: EXPENSE, keywords: ["starbucks", "cafeteria", "the coffee", "coffee shop"] },
  { category: "Café", confidence: "medium", types: EXPENSE, keywords: ["cafe"] },
  { category: "Padaria", confidence: "high", types: EXPENSE, keywords: ["padaria", "panificadora", "confeitaria"] },

  // Transporte
  { category: "Uber/99", confidence: "high", types: EXPENSE, keywords: ["uber", "99app", "99 app", "99pop", "99 tecnologia", "cabify", "indriver", "indrive"] },
  { category: "Uber/99", confidence: "medium", types: EXPENSE, keywords: ["taxi", "corrida"] },
  { category: "Combustível", confidence: "high", types: EXPENSE, keywords: ["ipiranga", "petrobras", "br mania", "posto", "auto posto", "shell select", "texaco", "ale combustiveis"] },
  { category: "Combustível", confidence: "medium", types: EXPENSE, keywords: ["gasolina", "etanol", "combustivel", "diesel", "alcool"] },
  { category: "Transporte público", confidence: "high", types: EXPENSE, keywords: ["bilhete unico", "sptrans", "cptm", "riocard", "metro", "supervia", "vlt", "brt"] },
  { category: "Transporte público", confidence: "medium", types: EXPENSE, keywords: ["onibus", "trem", "passagem"] },
  { category: "Estacionamento", confidence: "high", types: EXPENSE, keywords: ["estacionamento", "estapar", "zona azul", "multipark", "parking", "valet"] },
  { category: "Manutenção", confidence: "high", types: EXPENSE, keywords: ["ipva", "licenciamento", "detran", "autocenter", "auto center", "pneustore", "lava rapido", "oficina", "mecanica"] },
  { category: "Manutenção", confidence: "medium", types: EXPENSE, keywords: ["revisao", "pneu", "mecanico", "lavagem"] },

  // Moradia
  { category: "Aluguel", confidence: "high", types: EXPENSE, keywords: ["aluguel", "locacao de imovel", "imobiliaria"] },
  { category: "Condomínio", confidence: "high", types: EXPENSE, keywords: ["condominio"] },
  { category: "Luz", confidence: "high", types: EXPENSE, keywords: ["enel", "cemig", "copel", "cpfl", "celpe", "coelba", "eletropaulo", "neoenergia", "equatorial energia", "light servicos"] },
  { category: "Luz", confidence: "medium", types: EXPENSE, keywords: ["energia eletrica", "conta de luz"] },
  { category: "Água", confidence: "high", types: EXPENSE, keywords: ["sabesp", "cedae", "sanepar", "copasa", "caesb", "embasa", "saneamento", "aegea"] },
  { category: "Água", confidence: "medium", types: EXPENSE, keywords: ["conta de agua"] },
  { category: "Gás", confidence: "high", types: EXPENSE, keywords: ["comgas", "ultragaz", "liquigas", "copagaz", "naturgy", "nacional gas"] },
  { category: "Gás", confidence: "medium", types: EXPENSE, keywords: ["botijao"] },
  { category: "Internet", confidence: "high", types: EXPENSE, keywords: ["vivo fibra", "claro net", "net virtua", "oi fibra", "gvt", "algar fibra", "unifique", "desktop fibra", "internet"] },
  { category: "IPTU", confidence: "high", types: EXPENSE, keywords: ["iptu"] },

  // Saúde
  { category: "Farmácia", confidence: "high", types: EXPENSE, keywords: ["drogasil", "droga raia", "drogaraia", "raia drogasil", "pacheco", "drogaria", "farmacia", "panvel", "pague menos", "ultrafarma", "venancio"] },
  { category: "Farmácia", confidence: "medium", types: EXPENSE, keywords: ["remedio", "medicamento"] },
  { category: "Plano de saúde", confidence: "high", types: EXPENSE, keywords: ["unimed", "amil", "sulamerica", "sul america", "bradesco saude", "hapvida", "notredame", "golden cross", "plano de saude"] },
  { category: "Academia", confidence: "high", types: EXPENSE, keywords: ["smartfit", "smart fit", "gympass", "totalpass", "bodytech", "bluefit", "academia", "crossfit", "pilates"] },
  { category: "Exame", confidence: "high", types: EXPENSE, keywords: ["laboratorio", "fleury", "dasa", "delboni", "hermes pardini", "exame"] },
  { category: "Consulta", confidence: "high", types: EXPENSE, keywords: ["dentista", "odonto", "psicologo", "psicologa", "psiquiatra", "fisioterapia", "consulta medica"] },
  { category: "Consulta", confidence: "medium", types: EXPENSE, keywords: ["consulta", "clinica", "terapia", "medico"] },

  // Lazer / Assinaturas
  { category: "Streaming", confidence: "high", types: EXPENSE, keywords: ["netflix", "spotify", "disney plus", "disneyplus", "hbo max", "hbomax", "prime video", "primevideo", "youtube premium", "deezer", "globoplay", "paramount", "apple tv", "appletv", "crunchyroll"] },
  { category: "Software", confidence: "high", types: EXPENSE, keywords: ["aws", "amazon web services", "google cloud", "github", "openai", "chatgpt", "anthropic", "claude ai", "notion", "figma", "vercel", "digitalocean", "jetbrains", "atlassian", "canva", "adobe", "cursor", "heroku", "cloudflare"] },
  { category: "Nuvem", confidence: "high", types: EXPENSE, keywords: ["icloud", "google one", "dropbox", "onedrive", "backblaze"] },
  { category: "Telefonia", confidence: "high", types: EXPENSE, keywords: ["recarga celular", "tim celular", "vivo movel", "claro movel"] },
  { category: "Telefonia", confidence: "medium", types: EXPENSE, keywords: ["vivo", "tim", "claro", "recarga"] },
  { category: "Bar", confidence: "high", types: EXPENSE, keywords: ["cervejaria", "choperia", "boteco", "adega"] },
  { category: "Bar", confidence: "medium", types: EXPENSE, keywords: ["bar", "pub", "cerveja", "chopp", "balada"] },
  { category: "Cinema", confidence: "high", types: EXPENSE, keywords: ["cinemark", "cinepolis", "uci cinemas", "kinoplex", "cinesystem", "cinema"] },
  { category: "Jogos", confidence: "high", types: EXPENSE, keywords: ["steam", "playstation", "psn", "xbox", "nintendo", "epic games", "riot games", "blizzard", "garena"] },
  { category: "Viagem", confidence: "high", types: EXPENSE, keywords: ["airbnb", "booking com", "booking", "decolar", "latam", "gol linhas", "azul linhas", "cvc viagens", "expedia", "hotel", "pousada", "hostel", "123milhas"] },
  { category: "Eventos", confidence: "high", types: EXPENSE, keywords: ["sympla", "eventbrite", "ticketmaster", "tickets for fun", "ingresse", "teatro"] },

  // Compras
  { category: "Roupas", confidence: "high", types: EXPENSE, keywords: ["zara", "renner", "riachuelo", "c&a", "shein", "hering", "marisa", "youcom", "reserva", "centauro", "netshoes", "decathlon", "nike", "adidas"] },
  { category: "Eletrônicos", confidence: "high", types: EXPENSE, keywords: ["kabum", "kalunga", "fast shop", "casas bahia", "magazine luiza", "magalu", "ponto frio", "terabyte", "pichau", "apple store", "samsung"] },
  { category: "Casa", confidence: "high", types: EXPENSE, keywords: ["leroy merlin", "telhanorte", "tok stok", "tokstok", "mobly", "madeira madeira", "camicado", "ikea", "obramax"] },
  { category: "Presentes", confidence: "medium", types: EXPENSE, keywords: ["presente", "lembranca"] },
  { category: "Compras", confidence: "low", types: EXPENSE, keywords: ["mercado livre", "mercadolivre", "amazon", "amazon com", "aliexpress", "shopee", "americanas", "temu"], warning: "Marketplace: confirme o que foi comprado antes de aceitar a categoria." },

  // Educação
  { category: "Curso", confidence: "high", types: EXPENSE, keywords: ["udemy", "alura", "coursera", "rocketseat", "hotmart", "curso"] },
  { category: "Livros", confidence: "high", types: EXPENSE, keywords: ["livraria", "kindle", "saraiva", "estante virtual"] },
  { category: "Escola", confidence: "high", types: EXPENSE, keywords: ["colegio", "escola", "creche"] },
  { category: "Mensalidade", confidence: "high", types: EXPENSE, keywords: ["mensalidade", "faculdade", "universidade"] },

  // Serviços
  { category: "Cabeleireiro", confidence: "high", types: EXPENSE, keywords: ["barbearia", "barbeiro", "cabeleireiro", "salao de beleza", "manicure"] },
  { category: "Lavanderia", confidence: "high", types: EXPENSE, keywords: ["lavanderia"] },
  { category: "Reparos", confidence: "medium", types: EXPENSE, keywords: ["encanador", "eletricista", "conserto", "reparo", "chaveiro"] },

  // Pets
  { category: "Petshop", confidence: "high", types: EXPENSE, keywords: ["petz", "cobasi", "petlove", "petshop", "pet shop"] },
  { category: "Veterinário", confidence: "high", types: EXPENSE, keywords: ["veterinario", "clinica veterinaria"] },
  { category: "Ração", confidence: "medium", types: EXPENSE, keywords: ["racao"] },

  // Impostos e taxas
  { category: "Juros", confidence: "high", types: EXPENSE, keywords: ["juros rotativo", "credito rotativo", "encargos de atraso", "juros de mora", "multa e juros", "juros"] },
  { category: "Tarifa bancária", confidence: "high", types: EXPENSE, keywords: ["tarifa", "anuidade", "cesta de servicos", "taxa de manutencao", "iof"] },
  { category: "Imposto", confidence: "high", types: EXPENSE, keywords: ["darf", "irpf", "das mei", "imposto de renda", "imposto", "inss", "iss"] },
  { category: "Multa", confidence: "medium", types: EXPENSE, keywords: ["multa"] },

  // Dívidas
  { category: "Fatura de cartão", confidence: "medium", types: BOTH, keywords: ["pagamento de fatura", "pagamento fatura", "pgto fatura", "pagto fatura", "fatura cartao", "pagamento recebido", "pagamento efetuado"], warning: "Parece pagamento de fatura de cartão — o certo é registrar como transferência, senão o gasto conta duas vezes." },
  { category: "Empréstimo", confidence: "high", types: EXPENSE, keywords: ["emprestimo", "credito pessoal", "cred pessoal"] },
  { category: "Financiamento", confidence: "high", types: EXPENSE, keywords: ["financiamento", "consorcio"] },

  // Investimentos
  { category: "Aporte", confidence: "medium", types: EXPENSE, keywords: ["aplicacao", "tesouro direto", "aporte", "cdb", "lci", "lca"], warning: "Investimento não é gasto — considere registrar como transferência para a conta de investimento." },
  { category: "Resgate", confidence: "medium", types: INCOME, keywords: ["resgate"] },
  { category: "Dividendos", confidence: "high", types: INCOME, keywords: ["dividendos", "jcp", "juros sobre capital", "rendimento", "rendimentos"] },

  // Income
  { category: "Salário", confidence: "high", types: INCOME, keywords: ["salario", "folha de pagamento", "remuneracao", "contracheque", "holerite", "credito de salario"] },
  { category: "13º", confidence: "high", types: INCOME, keywords: ["decimo terceiro", "13 salario", "13o salario"] },
  { category: "Férias", confidence: "high", types: INCOME, keywords: ["ferias"] },
  { category: "Bônus", confidence: "high", types: INCOME, keywords: ["plr", "participacao nos lucros", "bonus"] },
  { category: "Freelance", confidence: "high", types: INCOME, keywords: ["freela", "freelance", "consultoria"] },
  { category: "Venda", confidence: "high", types: INCOME, keywords: ["olx", "enjoei", "venda"] },
  { category: "Reembolso", confidence: "high", types: INCOME, keywords: ["reembolso", "estorno", "devolucao", "ressarcimento", "cancelamento de compra"] },
  { category: "Cashback", confidence: "high", types: INCOME, keywords: ["cashback"] },
  { category: "Aluguel recebido", confidence: "high", types: INCOME, keywords: ["aluguel recebido"] },

  // Payment rails: a method, not a category. Left in `Outros` on purpose, with a
  // warning, because guessing what a PIX bought is exactly how a report gets
  // quietly wrong.
  { category: "Outros", confidence: "low", types: BOTH, keywords: ["pix", "ted", "doc", "transferencia", "transf"], warning: "PIX/transferência é meio de pagamento, não categoria — vale conferir o que foi." },
  { category: "Outros", confidence: "low", types: EXPENSE, keywords: ["saque", "retirada"], warning: "Saque não é gasto: o certo é uma transferência para a Carteira, e o gasto entra quando o dinheiro for usado." },
];

const FALLBACK_CATEGORY = "Outros";

/**
 * Guesses a category, or gives up honestly.
 *
 * Only rules matching the transaction's direction are considered: without that,
 * "estorno" on a debit line would land in `Renda extra` and a salary credit in
 * `Salário` would compete with an expense rule. Among the survivors the highest
 * confidence wins, and within the same confidence the longest keyword — that is
 * what makes "uber eats" beat "uber".
 */
export function guessCategory(description: string, type: EntryType): CategoryGuess {
  const haystack = ` ${normalizeDescription(description)} `;
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

  let best: { rule: Rule; keyword: string } | null = null;
  for (const rule of RULES) {
    if (!rule.types.includes(type)) continue;
    for (const keyword of rule.keywords) {
      // Space-padded containment gives whole-word matching without a regex per
      // keyword: `normalizeDescription` has already turned every separator into
      // a single space.
      if (!haystack.includes(` ${keyword} `)) continue;
      if (
        best === null ||
        rank[rule.confidence] > rank[best.rule.confidence] ||
        (rank[rule.confidence] === rank[best.rule.confidence] &&
          keyword.length > best.keyword.length)
      ) {
        best = { rule, keyword };
      }
    }
  }

  if (!best) return { category: FALLBACK_CATEGORY, confidence: "low", matched: null };
  return {
    category: best.rule.category,
    confidence: best.rule.confidence,
    matched: best.keyword,
  };
}

/** The Portuguese warning a rule attaches, if any. */
function warningFor(description: string, type: EntryType): string | null {
  const guess = guessCategory(description, type);
  if (!guess.matched) return null;
  const rule = RULES.find(
    (r) => r.category === guess.category && r.keywords.includes(guess.matched!),
  );
  return rule?.warning ?? null;
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Turns the file's bytes into text without mangling "Alimentação".
 *
 * Brazilian banks still ship OFX in cp1252/ISO-8859-1 far more often than in
 * UTF-8, and reading those bytes as UTF-8 either throws or produces mojibake
 * that then lands in the ledger for good. The order below is deliberate: the
 * file's own declaration wins, and only when there is none does the shape of the
 * bytes decide — a cp1252 file with an accent in it is almost never valid UTF-8,
 * so a strict UTF-8 decode is a reliable test.
 */
export function decodeStatement(bytes: Buffer): { text: string; encoding: string } {
  let body = bytes;
  if (body.length >= 3 && body.subarray(0, 3).equals(UTF8_BOM)) {
    body = body.subarray(3);
    return { text: new TextDecoder("utf-8").decode(body), encoding: "utf-8" };
  }

  // The declaration, from the OFX 1.x header or the OFX 2.x XML prolog. Read
  // from the first bytes only, latin1-decoded so this never throws.
  const head = body.subarray(0, 512).toString("latin1").toLowerCase();
  const declared =
    /charset[:=]\s*"?([a-z0-9-]+)/.exec(head)?.[1] ??
    /encoding[:=]\s*"?([a-z0-9-]+)/.exec(head)?.[1] ??
    null;

  if (declared) {
    if (/utf-?8/.test(declared)) {
      return { text: new TextDecoder("utf-8").decode(body), encoding: "utf-8" };
    }
    if (/1252|8859|latin|cp1252|ansi/.test(declared)) {
      return { text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
    }
    // USASCII / NONE / anything else: undecided, fall through to sniffing.
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(body),
      encoding: "utf-8",
    };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
  }
}

/** SGML/XML entities, which OFX files do carry. */
function unescapeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function cleanText(value: string): string {
  return unescapeEntities(value).replace(/\s+/g, " ").trim();
}

/** Keeps a description usable in a chat and inside a TEXT column. */
function tidyDescription(value: string): string {
  const s = cleanText(value);
  return s.length > 180 ? `${s.slice(0, 177)}...` : s;
}

/* -------------------------------------------------------------------------- */
/* Amount and date helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Splits a raw amount into sign and magnitude.
 *
 * `parseAmount` returns an absolute value (it is built for "gastei 30 reais"),
 * so the direction has to be read off the raw text before handing it over.
 * Accounting parentheses — `(1.234,56)` — mean negative too.
 */
function signedAmount(raw: string): { cents: number; negative: boolean } {
  const text = String(raw ?? "").trim();
  const parenthesised = /^\(.*\)$/.test(text);
  const negative = parenthesised || /^-/.test(text) || /-\s*$/.test(text);
  const magnitude = text.replace(/[()]/g, "").replace(/^[-+]+/, "").replace(/-\s*$/, "");
  return { cents: parseAmount(magnitude), negative };
}

/**
 * OFX dates: `YYYYMMDD`, optionally with a time and a timezone suffix
 * (`20260803120000[-3:BRT]`). Only the calendar day matters here — the ledger
 * files everything by date in São Paulo, and the intraday time would only add a
 * timezone bug.
 */
function parseOfxDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(raw ?? "").trim());
  if (!m) throw new FinError(`Data do extrato ilegível: ${JSON.stringify(raw)}.`);
  return parseDate(`${m[1]}-${m[2]}-${m[3]}`);
}

/** CSV dates: ISO, `YYYY/MM/DD`, `DD/MM/YYYY`, any of them with a time glued on. */
function parseCsvDate(raw: string): string {
  let text = String(raw ?? "").trim();
  text = text.split(/[ T]/)[0];
  const iso = /^(\d{4})[/.](\d{2})[/.](\d{2})$/.exec(text);
  if (iso) text = `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (text === "") throw new FinError("Data vazia.");
  return parseDate(text);
}

/* -------------------------------------------------------------------------- */
/* OFX                                                                        */
/* -------------------------------------------------------------------------- */

interface Token {
  tag: string;
  value: string;
  closing: boolean;
}

/**
 * Tokenises OFX without pretending it is XML.
 *
 * It is SGML: `<TRNAMT>-45.90` never closes, `<MEMO>` sometimes does, and a
 * real bank file mixes both in the same document. So instead of a tree, this
 * reads a flat stream of `<TAG>text-until-the-next-angle-bracket` and lets the
 * caller assemble records. An XML parser would reject these files outright.
 */
function tokenizeOfx(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\s*(\/?)\s*([A-Za-z0-9._:-]+)\s*>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ closing: m[1] === "/", tag: m[2].toUpperCase(), value: m[3] });
  }
  return tokens;
}

export function parseOfx(bytes: Buffer): ParsedStatement {
  const { text, encoding } = decodeStatement(bytes);
  const tokens = tokenizeOfx(text);
  if (!tokens.length) {
    throw new FinError(
      "Não encontrei nenhuma tag OFX no arquivo. Confira se é mesmo um extrato OFX.",
    );
  }

  const entries: StatementEntry[] = [];
  const warnings: string[] = [];
  let kind: "bank" | "card" | "unknown" = "unknown";
  let accountRef: string | null = null;
  let lastAccountBlock: "bank" | "card" | null = null;
  let current: Record<string, string> | null = null;
  let index = 0;

  const flush = () => {
    if (!current) return;
    const record = current;
    current = null;
    index++;

    const description =
      tidyDescription(record.MEMO ?? "") ||
      tidyDescription(record.NAME ?? "") ||
      tidyDescription(record.CHECKNUM ?? "") ||
      "Lançamento importado";

    const entry: StatementEntry = {
      index,
      date: null,
      amount_cents: null,
      type: null,
      description,
      external_id: cleanText(record.FITID ?? "") || null,
      account_ref: accountRef,
      raw_type: cleanText(record.TRNTYPE ?? "").toUpperCase() || null,
      invalid_reason: null,
    };

    try {
      const rawDate = record.DTPOSTED ?? record.DTUSER ?? record.DTAVAIL;
      if (!rawDate) throw new FinError("Lançamento sem data (DTPOSTED).");
      entry.date = parseOfxDate(rawDate);
    } catch (e) {
      entry.invalid_reason = e instanceof FinError ? e.message : "Data ilegível.";
      entries.push(entry);
      return;
    }

    try {
      if (record.TRNAMT === undefined) throw new FinError("Lançamento sem valor (TRNAMT).");
      const { cents, negative } = signedAmount(record.TRNAMT);
      entry.amount_cents = cents;
      // The whole sign question, in one line: money out is negative in OFX,
      // for a bank account and for a credit card alike. Importing a credit as
      // an expense would invent spending that never happened.
      entry.type = negative ? "expense" : "income";
    } catch (e) {
      entry.invalid_reason =
        e instanceof FinError ? e.message : "Valor ilegível no lançamento.";
    }

    entries.push(entry);
  };

  for (const token of tokens) {
    if (token.tag === "STMTTRN") {
      // A new record starts: whatever was open ends here, closing tag or not.
      if (token.closing) flush();
      else {
        flush();
        current = {};
      }
      continue;
    }

    // The last record in the list often has no closing tag, so the end of the
    // list is what closes it — otherwise `<LEDGERBAL>` would be read into it.
    if (token.tag === "BANKTRANLIST" && token.closing) {
      flush();
      continue;
    }

    if (token.tag === "CREDITCARDMSGSRSV1" || token.tag === "CCSTMTRS") {
      if (!token.closing) kind = "card";
      continue;
    }
    if (token.tag === "BANKMSGSRSV1" || token.tag === "STMTRS") {
      if (!token.closing && kind === "unknown") kind = "bank";
      continue;
    }
    if (token.tag === "CCACCTFROM") {
      if (!token.closing) {
        lastAccountBlock = "card";
        kind = "card";
      }
      continue;
    }
    if (token.tag === "BANKACCTFROM") {
      if (!token.closing) {
        lastAccountBlock = "bank";
        if (kind === "unknown") kind = "bank";
      }
      continue;
    }
    if (token.tag === "ACCTID" && !token.closing && lastAccountBlock) {
      const value = cleanText(token.value);
      if (value) accountRef = value;
      continue;
    }

    if (current && !token.closing) {
      const value = token.value;
      // First occurrence wins: a closing `</MEMO>` re-emits the tag name with an
      // empty payload in some exports, and that must not erase the memo.
      if (current[token.tag] === undefined || cleanText(current[token.tag]) === "") {
        current[token.tag] = value;
      }
    }
  }
  flush();

  if (!entries.length) {
    throw new FinError(
      "O arquivo é OFX mas não tem nenhum lançamento (STMTTRN). Talvez o período exportado esteja vazio.",
    );
  }
  if (kind === "card") {
    warnings.push(
      "Extrato de cartão: pagamentos da fatura aparecem como entrada e provavelmente deveriam ser transferência.",
    );
  }

  return {
    format: "ofx",
    encoding,
    sign_convention: "debit-negative",
    sign_source: "default",
    account_ref: accountRef,
    statement_kind: kind,
    entries,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/** Splits CSV text, honouring quotes, doubled quotes and embedded newlines. */
function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field.trim() === "") {
      quoted = true;
      field = "";
      started = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      started = true;
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      continue;
    }
    field += c;
    started = true;
  }
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Blank lines are common at the end of a bank export and carry nothing.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function countOutsideQuotes(line: string, char: string): number {
  let count = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === char) count++;
  }
  return count;
}

/**
 * Picks the delimiter from the header line.
 *
 * `;` in Brazil (Excel in a pt-BR locale writes it, and so do most banks), `,`
 * for Nubank, tab occasionally. Whichever appears most in the header wins;
 * counting outside quotes keeps a `"Padaria, Café"` field from voting.
 */
export function sniffDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t"];
  let best = ",";
  let bestCount = 0;
  for (const c of candidates) {
    const n = countOutsideQuotes(headerLine, c);
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/** Header cell to a comparable key: accent-free, punctuation-free, collapsed. */
function headerKey(cell: string): string {
  return normalize(cell.replace(/^﻿/, ""))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DATE_HEADERS = [
  "data", "date", "data da compra", "data de compra", "data do lancamento",
  "data lancamento", "data movimento", "data valor", "data da transacao",
  "data transacao", "dt lancamento", "posted date", "transaction date",
];
const AMOUNT_HEADERS = [
  "valor", "amount", "value", "valor r", "valor brl", "montante",
  "valor da compra", "valor lancamento", "quantia",
];
const DESCRIPTION_HEADERS = [
  "descricao", "description", "title", "titulo", "historico", "estabelecimento",
  "lancamento", "memo", "detalhes", "detalhe", "descricao do lancamento",
  "nome", "merchant", "razao social",
];
const EXTERNAL_ID_HEADERS = ["identificador", "id", "fitid", "transaction id", "id da transacao"];
const DEBIT_HEADERS = ["debito", "debitos", "valor debito", "saida", "saidas"];
const CREDIT_HEADERS = ["credito", "creditos", "valor credito", "entrada", "entradas"];
/** Never an amount, whatever it looks like: it is the running balance. */
const BALANCE_HEADERS = ["saldo", "balance", "saldo final", "saldo atual"];

function findColumn(keys: string[], aliases: string[], exclude: string[] = []): number {
  for (const alias of aliases) {
    const i = keys.indexOf(alias);
    if (i >= 0) return i;
  }
  for (let i = 0; i < keys.length; i++) {
    if (exclude.includes(keys[i])) continue;
    if (aliases.some((alias) => keys[i].includes(alias))) return i;
  }
  return -1;
}

export function parseCsv(bytes: Buffer, sign: SignOption = "auto"): ParsedStatement {
  const { text, encoding } = decodeStatement(bytes);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = sniffDelimiter(firstLine);
  const rows = splitCsv(text, delimiter);

  if (rows.length < 2) {
    throw new FinError(
      "O CSV não tem linhas de lançamento — só o cabeçalho, ou está vazio.",
    );
  }

  const keys = rows[0].map(headerKey);
  const dateCol = findColumn(keys, DATE_HEADERS);
  const descCol = findColumn(keys, DESCRIPTION_HEADERS);
  let amountCol = findColumn(keys, AMOUNT_HEADERS, BALANCE_HEADERS);
  const debitCol = findColumn(keys, DEBIT_HEADERS);
  const creditCol = findColumn(keys, CREDIT_HEADERS);
  const idCol = findColumn(keys, EXTERNAL_ID_HEADERS);

  // Some banks split the money into two columns instead of signing one.
  const splitColumns = amountCol < 0 && (debitCol >= 0 || creditCol >= 0);

  const missing: string[] = [];
  if (dateCol < 0) missing.push("data");
  if (descCol < 0) missing.push("descrição");
  if (amountCol < 0 && !splitColumns) missing.push("valor");
  if (missing.length) {
    throw new FinError(
      `Não achei a coluna de ${missing.join(", ")} no CSV. ` +
        `O cabeçalho lido foi: ${rows[0].map((c) => c.trim()).filter(Boolean).join(", ") || "(vazio)"}. ` +
        "Exporte o extrato de novo mantendo a primeira linha de títulos.",
    );
  }

  const warnings: string[] = [];
  const dataRows = rows.slice(1);

  // Sign convention. Nubank's *card* export is the awkward one: it lists charges
  // as positive numbers, because the whole file is charges. Its header is the
  // English `date,title,amount` trio, which is a reliable tell. Everything else
  // follows the normal rule — money out is negative.
  let convention: SignConvention = "debit-negative";
  let signSource: ParsedStatement["sign_source"] = "default";
  if (sign === "debit-negative" || sign === "debit-positive") {
    convention = sign;
    signSource = "option";
  } else if (
    keys.includes("title") &&
    keys.includes("amount") &&
    keys.includes("date") &&
    idCol < 0
  ) {
    convention = "debit-positive";
    signSource = "header";
  }

  const entries: StatementEntry[] = [];
  let index = 0;
  let negatives = 0;

  for (const row of dataRows) {
    index++;
    const cell = (i: number) => (i >= 0 && i < row.length ? row[i] : "");
    const description = tidyDescription(cell(descCol)) || "Lançamento importado";

    const entry: StatementEntry = {
      index,
      date: null,
      amount_cents: null,
      type: null,
      description,
      external_id: cleanText(cell(idCol)) || null,
      account_ref: null,
      raw_type: null,
      invalid_reason: null,
    };

    try {
      entry.date = parseCsvDate(cell(dateCol));
    } catch (e) {
      entry.invalid_reason = e instanceof FinError ? e.message : "Data ilegível.";
      entries.push(entry);
      continue;
    }

    try {
      let cents: number;
      let negative: boolean;
      if (splitColumns) {
        const debit = cell(debitCol).trim();
        const credit = cell(creditCol).trim();
        if (debit && credit) {
          throw new FinError("Linha com débito e crédito ao mesmo tempo.");
        }
        if (!debit && !credit) throw new FinError("Linha sem valor.");
        const parsed = signedAmount(debit || credit);
        cents = parsed.cents;
        negative = debit ? true : parsed.negative;
      } else {
        const parsed = signedAmount(cell(amountCol));
        cents = parsed.cents;
        negative = parsed.negative;
      }
      if (negative) negatives++;
      entry.amount_cents = cents;
      entry.type =
        convention === "debit-positive"
          ? negative
            ? "income"
            : "expense"
          : negative
            ? "expense"
            : "income";
    } catch (e) {
      entry.invalid_reason = e instanceof FinError ? e.message : "Valor ilegível.";
    }

    entries.push(entry);
  }

  if (!entries.length) throw new FinError("O CSV não tem nenhum lançamento.");

  // Said out loud rather than guessed: a file with no negative line is either a
  // card statement of charges or an income-only export, and getting that
  // backwards would invert a whole month. The person confirms.
  if (negatives === 0 && signSource === "default" && entries.length >= 2) {
    warnings.push(
      "Nenhum valor negativo no arquivo: tratei tudo como entrada. " +
        "Se for uma fatura de cartão (só compras), reimporte com --sign debit-positive.",
    );
  }
  if (signSource === "header") {
    warnings.push(
      "Reconheci uma fatura de cartão do Nubank: valores positivos são compras, negativos são estornos.",
    );
  }

  return {
    format: "csv",
    encoding,
    sign_convention: convention,
    sign_source: signSource,
    account_ref: null,
    statement_kind: convention === "debit-positive" ? "card" : "bank",
    entries,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Format detection and file reading                                          */
/* -------------------------------------------------------------------------- */

export function detectFormat(bytes: Buffer, name?: string): StatementFormat {
  const head = bytes.subarray(0, 4096).toString("latin1").toUpperCase();
  if (head.includes("OFXHEADER") || head.includes("<OFX")) return "ofx";
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".ofx") || lower.endsWith(".qfx")) return "ofx";
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return "csv";
  // A statement is one or the other; CSV is the one that fails loudly and
  // usefully when it is wrong.
  return "csv";
}

export function parseStatement(
  bytes: Buffer,
  format: FormatOption = "auto",
  name?: string,
  sign: SignOption = "auto",
): ParsedStatement {
  const chosen = format === "auto" ? detectFormat(bytes, name) : format;
  if (chosen === "ofx") return parseOfx(bytes);
  return parseCsv(bytes, sign);
}

/** 8 MiB. A year of statements is a few hundred KB; anything this big is a mistake. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The directories a statement may be read from.
 *
 * The path reaches this process from a chat, through a model, so it is untrusted
 * input: `--file /etc/shadow` has to be refused rather than parsed and
 * error-reported (an error message quoting the first line of a file is a read
 * primitive). Symlinks are resolved before the check, so a link inside an
 * allowed directory cannot point out of it.
 */
function allowedRoots(): string[] {
  const roots = [process.cwd(), tmpdir(), "/opt/data", homedir()];
  if (process.env.TALLY_IMPORT_DIR) roots.push(process.env.TALLY_IMPORT_DIR);
  const real: string[] = [];
  for (const root of roots) {
    try {
      real.push(realpathSync(resolve(root)));
    } catch {
      // A root that does not exist on this machine simply allows nothing.
    }
  }
  return real;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function readStatementFile(path: string, maxBytes = MAX_FILE_BYTES): Buffer {
  if (!path || !String(path).trim()) {
    throw new FinError("Informe o arquivo do extrato com --file.");
  }

  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new FinError(`Não consegui abrir o arquivo ${JSON.stringify(path)}: ele não existe.`);
  }

  const roots = allowedRoots();
  if (!roots.some((root) => isInside(real, root))) {
    throw new FinError(
      "Esse caminho está fora das pastas onde eu posso ler extratos. " +
        "Salve o arquivo na pasta de dados do bot e tente de novo.",
    );
  }

  let stat;
  try {
    stat = statSync(real);
  } catch {
    throw new FinError(`Não consegui ler o arquivo ${JSON.stringify(path)}.`);
  }
  if (!stat.isFile()) {
    throw new FinError(`${JSON.stringify(path)} não é um arquivo.`);
  }
  if (stat.size === 0) {
    throw new FinError("O arquivo está vazio.");
  }
  if (stat.size > maxBytes) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    throw new FinError(
      `O arquivo tem ${mb} MB e o limite é ${Math.floor(maxBytes / (1024 * 1024))} MB. ` +
        "Exporte o extrato em períodos menores.",
    );
  }

  try {
    return readFileSync(real);
  } catch {
    throw new FinError(`Não consegui ler o arquivo ${JSON.stringify(path)}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                              */
/* -------------------------------------------------------------------------- */

interface Decision {
  entry: StatementEntry;
  status: RowStatus;
  reason: string | null;
  fitidMarker: string | null;
  hashMarker: string | null;
  category: string | null;
  confidence: Confidence | null;
  warning: string | null;
}

/** Counts this user's imported rows carrying a marker. Always user-scoped. */
function countMarker(db: Db, userId: number, marker: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND note LIKE ?")
    .get(userId, `%${marker}%`) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Decides, row by row, what is new and what the ledger already has.
 *
 * The rule, in full:
 *
 * 1. A row whose `FITID` marker is already in this user's ledger is a duplicate.
 *    A FITID is the bank's own identifier for that transaction, so this is exact
 *    and needs no heuristics.
 * 2. A repeated `FITID` inside the same file is a duplicate of the earlier line.
 * 3. Otherwise the content fingerprint decides, **by count**: the file's Nth row
 *    with a given fingerprint is a duplicate only while N is within the number of
 *    rows the ledger already holds for that fingerprint. Two identical coffees on
 *    the same day therefore both import the first time (N = 1 and 2 against 0
 *    existing), and neither imports the second time (N = 1 and 2 against 2
 *    existing).
 *
 * Steps 1 and 3 run together, and every row — duplicate or not — consumes one
 * fingerprint slot. That is what makes the formats interoperate: a row inserted
 * from an OFX carries both markers, so the same transaction arriving later in a
 * CSV (no FITID at all) is still recognised by fingerprint, and vice versa.
 *
 * Only previously *imported* rows take part. A transaction the person typed into
 * the chat has no marker and is never treated as a duplicate of a statement
 * line: "ifood" and "IFD*IFOOD.COM AGENCIA DE REST" would not match anyway, and
 * silently dropping a real statement line to protect a guess is the worse error.
 */
function decide(db: Db, userId: number, parsed: ParsedStatement): Decision[] {
  const decisions: Decision[] = [];
  const existingHash = new Map<string, number>();
  const seenHash = new Map<string, number>();
  const seenFitid = new Set<string>();

  for (const entry of parsed.entries) {
    if (entry.invalid_reason || !entry.date || !entry.amount_cents || !entry.type) {
      decisions.push({
        entry,
        status: "invalid",
        reason: entry.invalid_reason ?? "Lançamento incompleto.",
        fitidMarker: null,
        hashMarker: null,
        category: null,
        confidence: null,
        warning: null,
      });
      continue;
    }

    const guess = guessCategory(entry.description, entry.type);
    const fMarker = entry.external_id
      ? fitidMarker(userId, entry.account_ref, entry.external_id)
      : null;
    const hMarker = hashMarker(
      userId,
      entry.date,
      entry.amount_cents,
      entry.type,
      entry.description,
    );

    if (!existingHash.has(hMarker)) {
      existingHash.set(hMarker, countMarker(db, userId, hMarker));
    }
    const occurrence = (seenHash.get(hMarker) ?? 0) + 1;
    seenHash.set(hMarker, occurrence);

    let status: RowStatus = "new";
    let reason: string | null = null;

    if (fMarker && seenFitid.has(fMarker)) {
      status = "duplicate";
      reason = "FITID repetido dentro do próprio arquivo.";
    } else if (fMarker && countMarker(db, userId, fMarker) > 0) {
      status = "duplicate";
      reason = "Já importado antes (mesmo FITID do banco).";
    } else if (occurrence <= existingHash.get(hMarker)!) {
      status = "duplicate";
      reason = "Já importado antes (mesma data, valor e descrição).";
    }
    if (fMarker) seenFitid.add(fMarker);

    decisions.push({
      entry,
      status,
      reason,
      fitidMarker: fMarker,
      hashMarker: hMarker,
      category: guess.category,
      confidence: guess.confidence,
      warning: warningFor(entry.description, entry.type),
    });
  }

  return decisions;
}

/**
 * The preview's token.
 *
 * A digest of everything the file determined — bytes, format, sign convention,
 * and each parsed row down to its guessed category. It is *not* a digest of the
 * dedup outcome: the ledger may legitimately change between preview and apply
 * (a cron job, the other person, the same person typing an expense), and apply
 * re-deciding against the ledger of the moment is correct behaviour, not drift.
 * What the token pins down is that apply is looking at the same file, read the
 * same way, with the same categories the person approved.
 */
function previewToken(
  userId: number,
  bytes: Buffer,
  parsed: ParsedStatement,
  decisions: Decision[],
): string {
  const body = decisions
    .map((d) =>
      [
        d.entry.index,
        d.entry.date ?? "",
        d.entry.amount_cents ?? "",
        d.entry.type ?? "",
        d.category ?? "",
        d.hashMarker ?? "",
        d.fitidMarker ?? "",
      ].join(":"),
    )
    .join(",");
  return createHash("sha256")
    .update(
      [
        "token-v1",
        userId,
        parsed.format,
        parsed.sign_convention,
        createHash("sha256").update(bytes).digest("hex"),
        body,
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
}

/* -------------------------------------------------------------------------- */
/* Preview and apply                                                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_ROWS = 40;

function requireLedgerUser(db: Db, userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new FinError("--user-id precisa ser o id interno (users.id), um inteiro positivo.");
  }
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
    throw new FinError("Não achei esse usuário no banco. Faça login antes de importar.");
  }
}

/** Reads the statement bytes, from `opts.bytes` or from disk. */
function statementBytes(opts: ImportOptions): { bytes: Buffer; label: string } {
  if (opts.bytes) return { bytes: opts.bytes, label: opts.name ?? opts.file ?? "(memória)" };
  if (!opts.file) throw new FinError("Informe o arquivo do extrato com --file.");
  return { bytes: readStatementFile(opts.file), label: opts.file };
}

/**
 * Everything both phases need, derived once.
 *
 * Kept in one function so that preview and apply cannot drift apart: there is a
 * single place where a file becomes a list of decisions.
 */
function derive(db: Db, userId: number, opts: ImportOptions) {
  requireLedgerUser(db, userId);
  const { bytes, label } = statementBytes(opts);

  let parsed: ParsedStatement;
  try {
    parsed = parseStatement(bytes, opts.format ?? "auto", opts.name ?? opts.file, opts.sign ?? "auto");
  } catch (e) {
    if (e instanceof FinError) throw e;
    throw new FinError(
      `Não consegui interpretar o arquivo: ${(e as Error).message}. ` +
        "Confira se é um OFX ou um CSV de extrato.",
    );
  }

  const accountId = resolveAccount(db, userId, opts.account);
  const accountName = accountId
    ? ((
        db
          .prepare("SELECT name FROM accounts WHERE id = ? AND user_id = ?")
          .get(accountId, userId) as { name: string } | undefined
      )?.name ?? null)
    : null;

  const decisions = decide(db, userId, parsed);
  const token = previewToken(userId, bytes, parsed, decisions);

  if (opts.token && opts.token !== token) {
    throw new FinError(
      "O extrato mudou desde a prévia (arquivo ou formato diferente). " +
        "Rode a prévia de novo antes de confirmar.",
    );
  }

  return { parsed, decisions, token, accountId, accountName, label };
}

/**
 * Resolves a guessed category name to an id, never creating anything.
 *
 * A statement is full of merchant strings; letting it create categories would
 * grow a tree nobody asked for. If the guessed name is gone (renamed, deleted),
 * the row still lands — under `Outros`, or with no category at all rather than
 * being dropped. Losing a transaction is worse than losing its category.
 */
function categoryIdFor(db: Db, userId: number, name: string | null): number | null {
  for (const candidate of [name, FALLBACK_CATEGORY]) {
    if (!candidate) continue;
    try {
      const id = resolveCategory(db, userId, candidate, false);
      if (id) return id;
    } catch {
      // Not in this person's tree; fall through to Outros, then to null.
    }
  }
  return null;
}

function dateRange(decisions: Decision[]): { start: string | null; end: string | null } {
  const dates = decisions
    .filter((d) => d.status !== "invalid" && d.entry.date)
    .map((d) => d.entry.date!)
    .sort();
  return { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null };
}

function shortDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year.slice(2)}`;
}

function toRow(db: Db, userId: number, d: Decision): ImportRow {
  const categoryId = d.status === "invalid" ? null : categoryIdFor(db, userId, d.category);
  return {
    index: d.entry.index,
    status: d.status,
    date: d.entry.date,
    description: d.entry.description,
    amount_cents: d.entry.amount_cents,
    amount_fmt: d.entry.amount_cents === null ? null : formatMoney(d.entry.amount_cents),
    type: d.entry.type,
    category: d.category,
    full_category: categoryId ? fullCategoryName(db, userId, categoryId) : null,
    confidence: d.confidence,
    reason: d.reason,
    warning: d.warning,
  };
}

/** The Portuguese block the agent shows in the chat before touching anything. */
function previewText(preview: Omit<ImportPreview, "text">): string {
  const kind =
    preview.statement_kind === "card"
      ? "cartão"
      : preview.statement_kind === "bank"
        ? "conta"
        : "extrato";
  const lines: string[] = [];
  lines.push(`📄 *Prévia do extrato (${preview.format.toUpperCase()}, ${kind})*`);
  if (preview.date_start && preview.date_end) {
    lines.push(
      `_${shortDate(preview.date_start)} a ${shortDate(preview.date_end)} · ${preview.parsed_count} linha(s) lida(s)_`,
    );
  } else {
    lines.push(`_${preview.parsed_count} linha(s) lida(s)_`);
  }
  lines.push("");
  lines.push(`🆕 Novos: *${preview.new_count}*`);
  lines.push(`♻️ Já importados: ${preview.duplicate_count}`);
  if (preview.invalid_count) lines.push(`⚠️ Ilegíveis: ${preview.invalid_count}`);
  lines.push(`💸 Gastos novos: *${preview.new_expenses_fmt}*`);
  lines.push(`💰 Entradas novas: *${preview.new_income_fmt}*`);
  lines.push(`🟰 Líquido: ${preview.net_fmt}`);
  if (preview.account) lines.push(`🏦 Conta: ${preview.account}`);

  const shown = preview.rows.filter((r) => r.status === "new").slice(0, 12);
  if (shown.length) {
    lines.push("");
    lines.push("*Lançamentos novos:*");
    for (const r of shown) {
      const arrow = r.type === "income" ? "＋" : "−";
      const flag = r.confidence === "low" ? " ❓" : "";
      lines.push(
        `• ${shortDate(r.date!)} ${r.description} — ${arrow}${r.amount_fmt} → ${r.full_category ?? "Sem categoria"}${flag}`,
      );
    }
    const rest = preview.new_count - shown.length;
    if (rest > 0) lines.push(`_... e ${rest} lançamento(s)_`);
  }

  if (preview.low_confidence_count) {
    lines.push("");
    lines.push(
      `❓ ${preview.low_confidence_count} lançamento(s) sem categoria confiável — ` +
        "ficaram em Outros e valem uma olhada depois de importar.",
    );
  }
  for (const w of preview.warnings) lines.push(`⚠️ ${w}`);

  lines.push("");
  lines.push(
    preview.new_count === 0
      ? "Nada novo para importar: esse extrato já está todo no seu histórico."
      : `Confirme para eu gravar ${preview.new_count} lançamento(s).`,
  );
  return lines.join("\n");
}

/**
 * Phase one: read, categorise, decide — and write nothing.
 *
 * Not one statement in here or below it modifies the database. That is the point
 * of the phase: the person sees exactly what would happen before it happens.
 */
export function previewImport(db: Db, userId: number, opts: ImportOptions): ImportPreview {
  const { parsed, decisions, token, accountName, label } = derive(db, userId, opts);

  const rows = decisions.map((d) => toRow(db, userId, d));
  const news = rows.filter((r) => r.status === "new");
  const expenses = news
    .filter((r) => r.type === "expense")
    .reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);
  const income = news
    .filter((r) => r.type === "income")
    .reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);
  const { start, end } = dateRange(decisions);
  const cap = opts.maxRows === undefined ? DEFAULT_MAX_ROWS : opts.maxRows;

  const body: Omit<ImportPreview, "text"> = {
    applied: false,
    file: label,
    format: parsed.format,
    encoding: parsed.encoding,
    sign_convention: parsed.sign_convention,
    statement_kind: parsed.statement_kind,
    account: accountName,
    token,
    parsed_count: decisions.length,
    new_count: news.length,
    duplicate_count: rows.filter((r) => r.status === "duplicate").length,
    invalid_count: rows.filter((r) => r.status === "invalid").length,
    low_confidence_count: news.filter((r) => r.confidence === "low").length,
    new_expenses_cents: expenses,
    new_expenses_fmt: formatMoney(expenses),
    new_income_cents: income,
    new_income_fmt: formatMoney(income),
    net_fmt: formatMoney(income - expenses),
    date_start: start,
    date_end: end,
    rows: cap > 0 ? rows.slice(0, cap) : rows,
    rows_truncated: cap > 0 && rows.length > cap,
    warnings: parsed.warnings,
  };

  return { ...body, text: previewText(body) };
}

/**
 * Phase two: insert the new rows, all of them or none.
 *
 * Everything runs inside one `transaction()`, so a constraint that fires on the
 * twentieth row leaves the ledger exactly as it was — half an imported statement
 * is worse than none, because nobody can tell which half is missing.
 */
export function applyImport(db: Db, userId: number, opts: ImportOptions): ImportResult {
  const { parsed, decisions, token, accountId, accountName, label } = derive(db, userId, opts);

  const pending = decisions.filter((d) => d.status === "new");
  const ts = now();
  const created: CreatedRow[] = [];
  const ids: number[] = [];

  transaction(db, () => {
    // The same column list `cmdAdd` uses, in the same order. Columns added by
    // later migrations are left to their defaults on purpose — a statement line
    // is money that already moved, so `status` defaulting to 'paid' is exactly
    // right, and naming the column here would break the next time it is
    // reshaped.
    const insert = db.prepare(
      "INSERT INTO transactions (" +
        "  user_id, type, amount_cents, description, date, category_id, account_id," +
        "  dest_account_id, note, source, installment_num, installment_total," +
        "  installment_group, created_at, updated_at" +
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const d of pending) {
      const categoryId = categoryIdFor(db, userId, d.category);
      // Both markers, always: the FITID is the strong identity when the bank
      // gave one, and the fingerprint is what a later CSV of the same period
      // will match against.
      const note = `${d.fitidMarker ?? ""}${d.hashMarker}`;
      const info = insert.run(
        userId,
        d.entry.type!,
        d.entry.amount_cents!,
        d.entry.description,
        d.entry.date!,
        categoryId,
        accountId,
        null,
        note,
        IMPORT_SOURCE,
        null,
        null,
        null,
        ts,
        ts,
      );
      const id = Number(info.lastInsertRowid);
      ids.push(id);
      created.push({
        id,
        date: d.entry.date!,
        description: d.entry.description,
        amount_cents: d.entry.amount_cents!,
        amount_fmt: formatMoney(d.entry.amount_cents!),
        type: d.entry.type!,
        full_category: categoryId ? fullCategoryName(db, userId, categoryId) : "Sem categoria",
      });
    }
  });

  const expenses = created
    .filter((r) => r.type === "expense")
    .reduce((acc, r) => acc + r.amount_cents, 0);
  const income = created
    .filter((r) => r.type === "income")
    .reduce((acc, r) => acc + r.amount_cents, 0);
  const { start, end } = dateRange(decisions);
  const cap = opts.maxRows === undefined ? DEFAULT_MAX_ROWS : opts.maxRows;
  const duplicates = decisions.filter((d) => d.status === "duplicate").length;
  const invalid = decisions.filter((d) => d.status === "invalid").length;

  const lines: string[] = [];
  lines.push(`✅ *Extrato importado* (${parsed.format.toUpperCase()})`);
  lines.push(`🆕 ${created.length} lançamento(s) gravado(s)`);
  if (duplicates) lines.push(`♻️ ${duplicates} já estavam no histórico e foram ignorados`);
  if (invalid) lines.push(`⚠️ ${invalid} linha(s) ilegível(is) foram puladas`);
  lines.push(`💸 Gastos: *${formatMoney(expenses)}*`);
  lines.push(`💰 Entradas: *${formatMoney(income)}*`);
  if (start && end) lines.push(`📅 ${shortDate(start)} a ${shortDate(end)}`);
  if (accountName) lines.push(`🏦 Conta: ${accountName}`);
  for (const w of parsed.warnings) lines.push(`⚠️ ${w}`);

  return {
    applied: true,
    file: label,
    format: parsed.format,
    account: accountName,
    token,
    parsed_count: decisions.length,
    created_count: created.length,
    duplicate_count: duplicates,
    invalid_count: invalid,
    expenses_cents: expenses,
    expenses_fmt: formatMoney(expenses),
    income_cents: income,
    income_fmt: formatMoney(income),
    date_start: start,
    date_end: end,
    ids,
    created: cap > 0 ? created.slice(0, cap) : created,
    created_truncated: cap > 0 && created.length > cap,
    warnings: parsed.warnings,
    text: lines.join("\n"),
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `Import a bank or card statement (OFX / CSV) into one person's ledger.

  node statement-import.ts --db PATH --user-id N --file PATH [options]

Options:
  --db PATH        Database. Defaults to $TALLY_DB.
  --user-id N      Internal users.id (NOT a Telegram id). Required.
  --file PATH      Statement to read. Required.
  --format F       ofx | csv | auto (default auto).
  --account NAME   Account to file the rows under. Defaults to the user's default.
  --sign S         auto | debit-negative | debit-positive (CSV only).
  --token T        Token from a previous preview; refuses to apply if it differs.
  --apply          Actually insert. Without it, this only previews.
  --json           Full machine output: every row, no cap.

Prints JSON: {"ok": true, ...} on success (exit 0), {"ok": false, "error": "..."}
on failure (exit 1). Without --apply nothing is written.
`;

export function main(argv: string[]): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        db: { type: "string" },
        "user-id": { type: "string" },
        file: { type: "string" },
        format: { type: "string" },
        account: { type: "string" },
        sign: { type: "string" },
        token: { type: "string" },
        apply: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as Record<string, string | boolean | undefined>;
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: `Opção inválida: ${(e as Error).message}` }, null, 2)}\n`,
    );
    return 1;
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const str = (k: string): string | undefined =>
    typeof values[k] === "string" ? (values[k] as string) : undefined;

  let db: Db | undefined;
  try {
    const rawUserId = str("user-id");
    if (rawUserId === undefined) {
      throw new FinError("Informe --user-id (o id interno do usuário, users.id).");
    }
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new FinError("--user-id precisa ser o id interno (users.id), um inteiro positivo.");
    }

    const format = (str("format") ?? "auto") as FormatOption;
    if (!["ofx", "csv", "auto"].includes(format)) {
      throw new FinError(`Formato inválido: ${format}. Use ofx, csv ou auto.`);
    }
    const sign = (str("sign") ?? "auto") as SignOption;
    if (!["auto", "debit-negative", "debit-positive"].includes(sign)) {
      throw new FinError(
        `Valor inválido para --sign: ${sign}. Use auto, debit-negative ou debit-positive.`,
      );
    }

    db = connect(str("db") ?? process.env.TALLY_DB);
    if (currentVersion(db) < CURRENT_SCHEMA_VERSION) migrate(db);

    const opts: ImportOptions = {
      file: str("file"),
      format,
      account: str("account"),
      sign,
      token: str("token"),
      maxRows: values.json === true ? 0 : DEFAULT_MAX_ROWS,
    };

    const output =
      values.apply === true
        ? applyImport(db, userId, opts)
        : previewImport(db, userId, opts);

    process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const message =
      e instanceof FinError
        ? e.message
        : `Erro inesperado ao importar: ${(e as Error).message ?? String(e)}`;
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
