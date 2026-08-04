/**
 * Tests for the statement importer.
 *
 * Fixtures are built against the real schema through `db.ts`'s own helpers
 * (`connect`, `migrate`, `seedUser`) — never a hand-written CREATE TABLE, which
 * would silently drift the day a migration is appended.
 *
 * The weight is on the two things that would quietly ruin a ledger:
 * deduplication (re-importing a statement must add nothing, while two genuinely
 * identical coffees must both land) and isolation between the two people sharing
 * the database.
 *
 *     node --test tests/statement-import.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FinError,
  connect,
  migrate,
  now,
  seedUser,
  type Db,
} from "../skills/finance/scripts/db.ts";

import {
  IMPORT_SOURCE,
  applyImport,
  detectFormat,
  guessCategory,
  normalizeDescription,
  parseCsv,
  parseOfx,
  parseStatement,
  previewImport,
  readStatementFile,
  sniffDelimiter,
  type EntryType,
} from "../skills/finance/scripts/statement-import.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, "tests", "fixtures");
const CLI = join(ROOT, "skills", "finance", "scripts", "statement-import.ts");

const OFX_BANK = join(FIXTURES, "extrato-banco.ofx");
const OFX_CARD = join(FIXTURES, "extrato-cartao.ofx");
const CSV_NUBANK = join(FIXTURES, "nubank-conta.csv");
const CSV_CARD = join(FIXTURES, "nubank-cartao.csv");
const CSV_SEMICOLON = join(FIXTURES, "extrato-ponto-virgula.csv");
const GARBAGE = join(FIXTURES, "lixo.txt");

const bytesOf = (path: string) => readFileSync(path);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Ledger {
  path: string;
  db: Db;
}

function newLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "tally-import-"));
  const path = join(dir, "tally.db");
  const db = connect(path);
  migrate(db);
  return { path, db };
}

/**
 * A registered, seeded person. Returns the internal `users.id`.
 *
 * Deliberately touches only the columns of `users` that predate multi-user
 * support and have no default: the auth columns around them are still being
 * reshaped, and a fixture that spells them out would break on the next
 * migration for reasons that have nothing to do with importing statements.
 */
function addUser(db: Db, telegramId: string): number {
  const ts = now();
  const info = db
    .prepare(
      "INSERT INTO users (telegram_user_id, telegram_chat_id, display_name," +
        " authenticated_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(telegramId, telegramId, `User ${telegramId}`, ts, ts);
  const id = Number(info.lastInsertRowid);
  seedUser(db, id);
  return id;
}

/** A ledger with one person in it. */
function withUser(): { db: Db; path: string; userId: number } {
  const { db, path } = newLedger();
  return { db, path, userId: addUser(db, "111111111") };
}

function countTx(db: Db, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?")
    .get(userId) as { n: number };
  return Number(row.n);
}

interface Row {
  description: string;
  amount_cents: number;
  date: string;
  type: string;
  note: string | null;
  source: string;
  category: string | null;
}

function rowsOf(db: Db, userId: number): Row[] {
  return db
    .prepare(
      "SELECT t.description, t.amount_cents, t.date, t.type, t.note, t.source, c.name AS category" +
        " FROM transactions t LEFT JOIN categories c ON c.id = t.category_id" +
        " WHERE t.user_id = ? ORDER BY t.date, t.id",
    )
    .all(userId) as Row[];
}

const csvFile = (lines: string[]): Buffer => Buffer.from(`${lines.join("\n")}\n`, "utf8");

/* -------------------------------------------------------------------------- */

describe("normalização de descrição", () => {
  test("ignora acentos, caixa e espaços repetidos", () => {
    assert.equal(
      normalizeDescription("  PADARIA   SÃO  JOSÉ "),
      normalizeDescription("padaria sao jose"),
    );
  });

  test("remove contadores de parcela em qualquer formato", () => {
    const base = normalizeDescription("DROGARIA SAO PAULO");
    for (const variant of [
      "DROGARIA SAO PAULO PARCELA 03/12",
      "DROGARIA SAO PAULO PARC 3/12",
      "DROGARIA SAO PAULO PARCELA 3 DE 12",
      "DROGARIA SAO PAULO 03/12",
    ]) {
      assert.equal(normalizeDescription(variant), base, variant);
    }
  });

  test("remove terminal, NSU, autorização e documento", () => {
    const base = normalizeDescription("MERCADO BOM PRECO");
    assert.equal(normalizeDescription("MERCADO BOM PRECO TERM 0042"), base);
    assert.equal(normalizeDescription("MERCADO BOM PRECO NSU 998877"), base);
    assert.equal(normalizeDescription("MERCADO BOM PRECO AUT 12345 DOC 6789"), base);
  });

  test("remove prefixo de adquirente e de rede de cartão", () => {
    assert.equal(normalizeDescription("PAG*PADARIA SAO JOSE"), "padaria sao jose");
    assert.equal(normalizeDescription("MP*PADARIA SAO JOSE"), "padaria sao jose");
    assert.equal(
      normalizeDescription("COMPRA COM CARTAO PADARIA SAO JOSE"),
      "padaria sao jose",
    );
    assert.equal(normalizeDescription("Compra no débito - PADARIA SÃO JOSÉ"), "padaria sao jose");
  });

  test("remove CPF/CNPJ e números longos, mas mantém números curtos do nome", () => {
    assert.equal(normalizeDescription("LOJA 123.456.789-00"), "loja");
    assert.equal(normalizeDescription("MERCADO 987654"), "mercado");
    assert.ok(normalizeDescription("99 TECNOLOGIA").includes("99"));
  });

  test("nunca devolve string vazia", () => {
    assert.notEqual(normalizeDescription("0042 123.456.789-00"), "");
  });
});

describe("categorização", () => {
  const cases: [string, EntryType, string][] = [
    ["IFD*IFOOD.COM AGENCIA DE REST", "expense", "Delivery"],
    ["SABESP SANEAMENTO BASICO", "expense", "Água"],
    ["NETFLIX.COM", "expense", "Streaming"],
    ["GITHUB.COM", "expense", "Software"],
    ["UBER TRIP 043", "expense", "Uber/99"],
    ["UBER EATS", "expense", "Delivery"],
    ["SUPERMERCADO BOM PRECO", "expense", "Mercado"],
    ["CAFETERIA GRAO NOBRE", "expense", "Café"],
    ["PADARIA SAO JOSE", "expense", "Padaria"],
    ["DROGARIA SAO PAULO", "expense", "Farmácia"],
    ["Crédito de Salário Acme Ltda", "income", "Salário"],
    ["Estorno de compra", "income", "Reembolso"],
  ];
  for (const [description, type, expected] of cases) {
    test(`${description} → ${expected}`, () => {
      assert.equal(guessCategory(description, type).category, expected);
    });
  }

  test("a palavra-chave mais longa ganha (uber eats não é corrida)", () => {
    assert.equal(guessCategory("UBER EATS DELIVERY", "expense").matched, "uber eats");
  });

  test("regras de entrada não valem para saída", () => {
    // "estorno" é receita; num débito ele não pode virar Renda extra.
    assert.notEqual(guessCategory("Estorno de compra", "expense").category, "Reembolso");
  });

  test("na dúvida, Outros com confiança baixa", () => {
    const guess = guessCategory("XPTO 4718 LTDA", "expense");
    assert.equal(guess.category, "Outros");
    assert.equal(guess.confidence, "low");
    assert.equal(guess.matched, null);
  });

  test("PIX é meio de pagamento, não categoria, e vem sinalizado", () => {
    const guess = guessCategory("PIX ENVIADO JOAO DA SILVA", "expense");
    assert.equal(guess.category, "Outros");
    assert.equal(guess.confidence, "low");
  });
});

describe("OFX", () => {
  test("lê um arquivo com tags não fechadas", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    assert.equal(parsed.format, "ofx");
    assert.equal(parsed.entries.length, 6);
    assert.equal(parsed.entries.filter((e) => e.invalid_reason).length, 0);
  });

  test("acentos Latin-1 chegam corretos, não como mojibake", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    assert.equal(parsed.encoding, "windows-1252");
    const descriptions = parsed.entries.map((e) => e.description);
    assert.ok(descriptions.includes("Mercado Alimentação Ltda"), descriptions.join(" | "));
    assert.ok(descriptions.includes("SABESP SANEAMENTO BÁSICO"));
    assert.ok(descriptions.some((d) => d.includes("PADARIA SÃO JOSÉ")));
    for (const d of descriptions) assert.ok(!d.includes("Ã§"), `mojibake em ${d}`);
  });

  test("negativo é despesa, positivo é receita", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    const salary = parsed.entries.find((e) => e.description.includes("Salário"))!;
    assert.equal(salary.type, "income");
    assert.equal(salary.amount_cents, 530000);
    const ifood = parsed.entries.find((e) => e.description.includes("IFOOD"))!;
    assert.equal(ifood.type, "expense");
    assert.equal(ifood.amount_cents, 4590);
  });

  test("DTPOSTED com hora e fuso vira a data do calendário", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    assert.equal(parsed.entries[0].date, "2026-07-03");
  });

  test("guarda FITID e a conta do arquivo", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    assert.equal(parsed.entries[0].external_id, "BR0001");
    assert.equal(parsed.account_ref, "12345-6");
    assert.equal(parsed.statement_kind, "bank");
  });

  test("a última transação sem tag de fechamento não engole o saldo", () => {
    const parsed = parseOfx(bytesOf(OFX_BANK));
    const last = parsed.entries[parsed.entries.length - 1];
    assert.equal(last.description, "CAFETERIA GRAO NOBRE");
    assert.equal(last.amount_cents, 1200);
  });

  test("extrato de cartão (CREDITCARDMSGSRSV1) também é lido", () => {
    const parsed = parseOfx(bytesOf(OFX_CARD));
    assert.equal(parsed.statement_kind, "card");
    assert.equal(parsed.account_ref, "5555444433332222");
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[0].type, "expense");
    // O crédito da fatura é receita pelo sinal, mas vem com aviso.
    assert.equal(parsed.entries[2].type, "income");
    assert.ok(parsed.warnings.length > 0);
  });

  test("detecção automática reconhece OFX pelo cabeçalho", () => {
    assert.equal(detectFormat(bytesOf(OFX_BANK), "sem-extensao"), "ofx");
    assert.equal(parseStatement(bytesOf(OFX_CARD), "auto", OFX_CARD).format, "ofx");
  });

  test("OFX sem lançamentos falha em português", () => {
    const empty = Buffer.from("OFXHEADER:100\n<OFX>\n<BANKMSGSRSV1>\n</BANKMSGSRSV1>\n</OFX>", "utf8");
    assert.throws(() => parseOfx(empty), (e: unknown) => {
      assert.ok(e instanceof FinError);
      assert.match((e as FinError).message, /lançamento/i);
      return true;
    });
  });
});

describe("CSV", () => {
  test("Nubank de conta: vírgula, DD/MM/YYYY e 1234.56", () => {
    const parsed = parseCsv(bytesOf(CSV_NUBANK));
    assert.equal(parsed.entries.length, 5);
    assert.equal(parsed.entries[0].date, "2026-07-03");
    assert.equal(parsed.entries[0].amount_cents, 4590);
    assert.equal(parsed.entries[0].type, "expense");
    assert.equal(parsed.entries[4].amount_cents, 123456);
    // A coluna Identificador do Nubank serve de id estável, como o FITID.
    assert.equal(parsed.entries[0].external_id, "6a1b2c3d-0001-4a2b-9c3d-000000000001");
  });

  test("ponto e vírgula, BOM, colunas fora de ordem e 1.234,56", () => {
    const parsed = parseCsv(bytesOf(CSV_SEMICOLON));
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[0].description, "SUPERMERCADO EXTRA LOJA 3421");
    assert.equal(parsed.entries[0].amount_cents, 123456);
    assert.equal(parsed.entries[0].date, "2026-07-15");
    assert.equal(parsed.entries[0].type, "expense");
    assert.equal(parsed.entries[2].type, "income");
    assert.equal(parsed.entries[2].amount_cents, 20000);
  });

  test("a coluna Saldo nunca é confundida com Valor", () => {
    const parsed = parseCsv(bytesOf(CSV_SEMICOLON));
    // Saldo da primeira linha é 10.000,00; o valor é 1.234,56.
    assert.notEqual(parsed.entries[0].amount_cents, 1000000);
  });

  test("fatura de cartão do Nubank: positivo é compra", () => {
    const parsed = parseCsv(bytesOf(CSV_CARD));
    assert.equal(parsed.sign_convention, "debit-positive");
    assert.equal(parsed.sign_source, "header");
    assert.equal(parsed.entries[0].type, "expense");
    assert.equal(parsed.entries[0].amount_cents, 3990);
    // Estorno negativo numa fatura é dinheiro voltando.
    assert.equal(parsed.entries[2].type, "income");
  });

  test("--sign força a convenção", () => {
    const parsed = parseCsv(bytesOf(CSV_CARD), "debit-negative");
    assert.equal(parsed.sign_source, "option");
    assert.equal(parsed.entries[0].type, "income");
  });

  test("delimitador é farejado no cabeçalho", () => {
    assert.equal(sniffDelimiter("a;b;c"), ";");
    assert.equal(sniffDelimiter("a,b,c"), ",");
    assert.equal(sniffDelimiter('"a,b";c'), ";");
  });

  test("aceita os dois formatos de valor na mesma coluna", () => {
    const parsed = parseCsv(
      csvFile(["Data;Valor;Descricao", "01/07/2026;-1.234,56;A", "02/07/2026;-1234.56;B"]),
    );
    assert.equal(parsed.entries[0].amount_cents, 123456);
    assert.equal(parsed.entries[1].amount_cents, 123456);
  });

  test("aceita colunas separadas de débito e crédito", () => {
    const parsed = parseCsv(
      csvFile([
        "Data;Historico;Debito;Credito",
        "01/07/2026;Mercado;100,00;",
        "02/07/2026;Salario;;5.000,00",
      ]),
    );
    assert.equal(parsed.entries[0].type, "expense");
    assert.equal(parsed.entries[0].amount_cents, 10000);
    assert.equal(parsed.entries[1].type, "income");
    assert.equal(parsed.entries[1].amount_cents, 500000);
  });

  test("coluna obrigatória ausente falha em português nomeando o problema", () => {
    assert.throws(
      () => parseCsv(csvFile(["Data;Descricao", "01/07/2026;Mercado"])),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /coluna de valor/i);
        return true;
      },
    );
  });

  test("BOM não contamina o nome da primeira coluna", () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csvFile(["Data,Valor,Descrição", "01/07/2026,-10.00,Mercado"]),
    ]);
    const parsed = parseCsv(withBom);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].date, "2026-07-01");
  });

  test("campo com aspas e delimitador dentro é preservado", () => {
    const parsed = parseCsv(
      csvFile(['Data,Valor,Descrição', '01/07/2026,-10.00,"PADARIA, CAFE E CIA"']),
    );
    assert.equal(parsed.entries[0].description, "PADARIA, CAFE E CIA");
  });

  test("linha com data ilegível é marcada, não derruba o arquivo", () => {
    const parsed = parseCsv(
      csvFile(["Data;Valor;Descricao", "banana;-10,00;A", "02/07/2026;-20,00;B"]),
    );
    assert.ok(parsed.entries[0].invalid_reason);
    assert.equal(parsed.entries[1].invalid_reason, null);
  });
});

describe("prévia", () => {
  test("não escreve nada no banco", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(preview.applied, false);
    assert.equal(preview.new_count, 6);
    assert.equal(countTx(db, userId), 0);
  });

  test("resume em português: novos, duplicados, total e período", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(preview.duplicate_count, 0);
    assert.equal(preview.invalid_count, 0);
    assert.equal(preview.date_start, "2026-07-03");
    assert.equal(preview.date_end, "2026-07-15");
    // 45,90 + 129,90 + 8,50 + 1500,00 + 12,00
    assert.equal(preview.new_expenses_cents, 169630);
    assert.equal(preview.new_income_cents, 530000);
    assert.equal(preview.new_expenses_fmt, "R$ 1.696,30");
    assert.match(preview.text, /Prévia do extrato/);
    assert.match(preview.text, /Novos/);
  });

  test("traz a categoria e a confiança de cada linha", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    const ifood = preview.rows.find((r) => r.description.includes("IFOOD"))!;
    assert.equal(ifood.category, "Delivery");
    assert.equal(ifood.confidence, "high");
    assert.equal(ifood.full_category, "Alimentação > Delivery");
    const salary = preview.rows.find((r) => r.type === "income")!;
    assert.equal(salary.category, "Salário");
  });

  test("conta as linhas de categoria duvidosa", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, {
      bytes: csvFile(["Data;Valor;Descricao", "01/07/2026;-10,00;XPTO 4718 LTDA"]),
      name: "e.csv",
    });
    assert.equal(preview.low_confidence_count, 1);
    assert.equal(preview.rows[0].category, "Outros");
    assert.match(preview.text, /categoria confiável/);
  });
});

describe("aplicação", () => {
  test("grava com source=import, marcadores no note e categoria resolvida", () => {
    const { db, userId } = withUser();
    const result = applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(result.applied, true);
    assert.equal(result.created_count, 6);
    assert.equal(result.ids.length, 6);
    assert.equal(countTx(db, userId), 6);

    const rows = rowsOf(db, userId);
    for (const row of rows) {
      assert.equal(row.source, IMPORT_SOURCE);
      assert.match(row.note!, /\[imp:fitid:[0-9a-f]{16}\]\[imp:hash:[0-9a-f]{16}\]/);
      assert.ok(row.amount_cents > 0);
    }
    const ifood = rows.find((r) => r.description.includes("IFOOD"))!;
    assert.equal(ifood.type, "expense");
    assert.equal(ifood.category, "Delivery");
    const salary = rows.find((r) => r.type === "income")!;
    assert.equal(salary.amount_cents, 530000);
    assert.equal(salary.category, "Salário");
  });

  test("um CSV sem id do banco grava só o marcador de impressão digital", () => {
    const { db, userId } = withUser();
    applyImport(db, userId, {
      bytes: csvFile(["Data;Valor;Descricao", "01/07/2026;-10,00;Mercado"]),
      name: "e.csv",
    });
    const [row] = rowsOf(db, userId);
    assert.ok(!row.note!.includes("imp:fitid"));
    assert.match(row.note!, /^\[imp:hash:[0-9a-f]{16}\]$/);
  });

  test("importar o mesmo OFX duas vezes não cria nada na segunda", () => {
    const { db, userId } = withUser();
    const first = applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(first.created_count, 6);

    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(preview.new_count, 0);
    assert.equal(preview.duplicate_count, 6);

    const second = applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(second.created_count, 0);
    assert.equal(second.duplicate_count, 6);
    assert.equal(countTx(db, userId), 6);
  });

  test("importar o mesmo CSV duas vezes não cria nada na segunda", () => {
    const { db, userId } = withUser();
    assert.equal(applyImport(db, userId, { bytes: bytesOf(CSV_NUBANK), name: "n.csv" }).created_count, 5);
    assert.equal(applyImport(db, userId, { bytes: bytesOf(CSV_NUBANK), name: "n.csv" }).created_count, 0);
    assert.equal(countTx(db, userId), 5);
  });

  test("sem FITID nenhum: o mesmo arquivo duas vezes também não duplica", () => {
    const { db, userId } = withUser();
    const file = csvFile([
      "Data;Valor;Descricao",
      "01/07/2026;-10,00;Mercado do Bairro",
      "02/07/2026;-27,90;UBER TRIP 043",
    ]);
    assert.equal(applyImport(db, userId, { bytes: file, name: "a.csv" }).created_count, 2);
    assert.equal(applyImport(db, userId, { bytes: file, name: "a.csv" }).created_count, 0);
    assert.equal(countTx(db, userId), 2);
  });

  test("dois cafés idênticos no mesmo dia são dois cafés, não uma duplicata", () => {
    const { db, userId } = withUser();
    const file = csvFile([
      "Data;Valor;Descricao",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
    ]);
    const first = applyImport(db, userId, { bytes: file, name: "cafe.csv" });
    assert.equal(first.created_count, 2);

    // E reimportar o mesmo arquivo continua não criando nada.
    assert.equal(applyImport(db, userId, { bytes: file, name: "cafe.csv" }).created_count, 0);
    assert.equal(countTx(db, userId), 2);
  });

  test("um terceiro café legítimo no mesmo dia ainda entra", () => {
    const { db, userId } = withUser();
    const two = csvFile([
      "Data;Valor;Descricao",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
    ]);
    const three = csvFile([
      "Data;Valor;Descricao",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
      "20/07/2026;-9,00;CAFETERIA GRAO NOBRE",
    ]);
    applyImport(db, userId, { bytes: two, name: "a.csv" });
    const result = applyImport(db, userId, { bytes: three, name: "b.csv" });
    assert.equal(result.created_count, 1);
    assert.equal(result.duplicate_count, 2);
    assert.equal(countTx(db, userId), 3);
  });

  test("extratos que se sobrepõem: a interseção entra uma vez só", () => {
    const { db, userId } = withUser();
    const july = csvFile([
      "Data;Valor;Descricao",
      "10/07/2026;-10,00;Mercado do Bairro",
      "14/07/2026;-20,00;PADARIA SAO JOSE",
      "15/07/2026;-30,00;CAFETERIA GRAO NOBRE",
    ]);
    // Começa onde o outro terminou: duas linhas em comum, duas novas.
    const august = csvFile([
      "Data;Valor;Descricao",
      "14/07/2026;-20,00;PADARIA SAO JOSE",
      "15/07/2026;-30,00;CAFETERIA GRAO NOBRE",
      "18/07/2026;-40,00;SUPERMERCADO BOM PRECO",
      "20/07/2026;-50,00;DROGARIA SAO PAULO",
    ]);
    assert.equal(applyImport(db, userId, { bytes: july, name: "jul.csv" }).created_count, 3);
    const second = applyImport(db, userId, { bytes: august, name: "ago.csv" });
    assert.equal(second.created_count, 2);
    assert.equal(second.duplicate_count, 2);
    assert.equal(countTx(db, userId), 5);

    const padarias = rowsOf(db, userId).filter((r) => r.description.includes("PADARIA"));
    assert.equal(padarias.length, 1);
  });

  test("OFX e depois CSV do mesmo período não duplicam entre formatos", () => {
    const { db, userId } = withUser();
    assert.equal(applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).created_count, 6);

    // As mesmas transações, escritas como o CSV do banco escreveria: sem FITID e
    // com a linha da padaria redigida de outro jeito. A impressão digital é que
    // tem de reconhecê-las.
    const csv = csvFile([
      "Data;Valor;Descricao",
      "03/07/2026;-45,90;IFD*IFOOD.COM AGENCIA DE REST",
      "05/07/2026;-129,90;SABESP SANEAMENTO BASICO",
      "05/07/2026;5300,00;Credito de Salario Acme Ltda",
      "10/07/2026;-8,50;Compra no debito - PADARIA SAO JOSE",
      "12/07/2026;-1500,00;Mercado Alimentacao Ltda",
      "15/07/2026;-12,00;CAFETERIA GRAO NOBRE",
    ]);
    const preview = previewImport(db, userId, { bytes: csv, name: "e.csv" });
    assert.equal(preview.new_count, 0, preview.rows.map((r) => `${r.status} ${r.description}`).join(" | "));
    assert.equal(applyImport(db, userId, { bytes: csv, name: "e.csv" }).created_count, 0);
    assert.equal(countTx(db, userId), 6);
  });

  test("linhas ilegíveis são puladas e o resto entra", () => {
    const { db, userId } = withUser();
    const result = applyImport(db, userId, {
      bytes: csvFile([
        "Data;Valor;Descricao",
        "banana;-10,00;A",
        "02/07/2026;-20,00;PADARIA SAO JOSE",
      ]),
      name: "e.csv",
    });
    assert.equal(result.created_count, 1);
    assert.equal(result.invalid_count, 1);
    assert.equal(countTx(db, userId), 1);
  });

  test("aplicar é atômico: uma falha no meio não deixa nada gravado", () => {
    const { db, userId } = withUser();
    // Uma falha real de banco no meio da transação, sem gancho de teste no
    // código de produção: um trigger que aborta a segunda inserção.
    db.exec(
      "CREATE TRIGGER t_boom BEFORE INSERT ON transactions" +
        " WHEN NEW.description LIKE '%EXPLODE%'" +
        " BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const file = csvFile([
      "Data;Valor;Descricao",
      "01/07/2026;-10,00;PADARIA SAO JOSE",
      "02/07/2026;-20,00;EXPLODE AQUI",
      "03/07/2026;-30,00;CAFETERIA GRAO NOBRE",
    ]);
    assert.throws(() => applyImport(db, userId, { bytes: file, name: "e.csv" }));
    assert.equal(countTx(db, userId), 0);

    // E depois de remover a falha, o mesmo arquivo entra inteiro.
    db.exec("DROP TRIGGER t_boom");
    assert.equal(applyImport(db, userId, { bytes: file, name: "e.csv" }).created_count, 3);
  });

  test("importar não cria categorias novas", () => {
    const { db, userId } = withUser();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM categories WHERE user_id = ?")
      .get(userId) as { n: number };
    applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM categories WHERE user_id = ?")
      .get(userId) as { n: number };
    assert.equal(Number(after.n), Number(before.n));
  });

  test("as linhas vão para a conta pedida", () => {
    const { db, userId } = withUser();
    db.prepare(
      "INSERT INTO accounts (user_id, name, type, created_at) VALUES (?, 'Nubank', 'checking', ?)",
    ).run(userId, now());
    applyImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx", account: "Nubank" });
    const row = db
      .prepare(
        "SELECT a.name AS account FROM transactions t JOIN accounts a ON a.id = t.account_id" +
          " WHERE t.user_id = ? LIMIT 1",
      )
      .get(userId) as { account: string };
    assert.equal(row.account, "Nubank");
  });
});

describe("prévia e aplicação combinam", () => {
  test("o token da prévia vale na aplicação", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    const result = applyImport(db, userId, {
      bytes: bytesOf(OFX_BANK),
      name: "e.ofx",
      token: preview.token,
    });
    assert.equal(result.created_count, preview.new_count);
    assert.equal(result.token, preview.token);
  });

  test("token de outro arquivo é recusado em português", () => {
    const { db, userId } = withUser();
    const preview = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.throws(
      () =>
        applyImport(db, userId, {
          bytes: bytesOf(CSV_NUBANK),
          name: "n.csv",
          token: preview.token,
        }),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /prévia/i);
        return true;
      },
    );
    assert.equal(countTx(db, userId), 0);
  });

  test("o token não muda entre duas prévias do mesmo arquivo", () => {
    const { db, userId } = withUser();
    const a = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    const b = previewImport(db, userId, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(a.token, b.token);
  });

  test("o token é por pessoa", () => {
    const { db } = newLedger();
    const a = addUser(db, "111111111");
    const b = addUser(db, "222222222");
    assert.notEqual(
      previewImport(db, a, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).token,
      previewImport(db, b, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).token,
    );
  });
});

describe("isolamento entre as duas pessoas", () => {
  test("cada uma importa o mesmo arquivo e fica com as próprias linhas", () => {
    const { db } = newLedger();
    const a = addUser(db, "111111111");
    const b = addUser(db, "222222222");

    assert.equal(applyImport(db, a, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).created_count, 6);
    // Nada do que A importou pode contar como duplicata para B.
    const previewB = previewImport(db, b, { bytes: bytesOf(OFX_BANK), name: "e.ofx" });
    assert.equal(previewB.duplicate_count, 0);
    assert.equal(previewB.new_count, 6);
    assert.equal(applyImport(db, b, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).created_count, 6);

    assert.equal(countTx(db, a), 6);
    assert.equal(countTx(db, b), 6);

    // E a reimportação de cada uma continua sendo idempotente.
    assert.equal(applyImport(db, a, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).created_count, 0);
    assert.equal(applyImport(db, b, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }).created_count, 0);
    assert.equal(countTx(db, a), 6);
    assert.equal(countTx(db, b), 6);
  });

  test("os marcadores das duas pessoas são diferentes para a mesma transação", () => {
    const { db } = newLedger();
    const a = addUser(db, "111111111");
    const b = addUser(db, "222222222");
    const file = csvFile(["Data;Valor;Descricao", "01/07/2026;-10,00;Mercado do Bairro"]);
    applyImport(db, a, { bytes: file, name: "e.csv" });
    applyImport(db, b, { bytes: file, name: "e.csv" });
    assert.notEqual(rowsOf(db, a)[0].note, rowsOf(db, b)[0].note);
  });

  test("um id de usuário inexistente é recusado sem gravar nada", () => {
    const { db, userId } = withUser();
    assert.throws(
      () => applyImport(db, 4242, { bytes: bytesOf(OFX_BANK), name: "e.ofx" }),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /usuário/i);
        return true;
      },
    );
    assert.equal(countTx(db, userId), 0);
  });
});

describe("arquivo malformado", () => {
  test("um texto qualquer falha em português e não grava nada", () => {
    const { db, userId } = withUser();
    assert.throws(
      () => applyImport(db, userId, { file: GARBAGE, format: "auto" }),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /coluna de/i);
        return true;
      },
    );
    assert.equal(countTx(db, userId), 0);
  });

  test("um OFX truncado falha em português", () => {
    const { db, userId } = withUser();
    assert.throws(
      () =>
        applyImport(db, userId, {
          bytes: Buffer.from("OFXHEADER:100\nDATA:OFXSGML\n\nlixo sem tag alguma", "utf8"),
          name: "x.ofx",
          format: "ofx",
        }),
      FinError,
    );
    assert.equal(countTx(db, userId), 0);
  });
});

describe("validação do arquivo", () => {
  test("caminho fora das pastas permitidas é recusado", () => {
    assert.throws(
      () => readStatementFile("/etc/hosts"),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /fora das pastas/i);
        return true;
      },
    );
  });

  test("arquivo grande demais é recusado antes de ser lido", () => {
    assert.throws(
      () => readStatementFile(OFX_BANK, 64),
      (e: unknown) => {
        assert.ok(e instanceof FinError);
        assert.match((e as FinError).message, /limite/i);
        return true;
      },
    );
  });

  test("arquivo inexistente e arquivo vazio falham em português", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-import-file-"));
    const empty = join(dir, "vazio.csv");
    writeFileSync(empty, "");
    assert.throws(() => readStatementFile(join(dir, "nao-existe.ofx")), FinError);
    assert.throws(
      () => readStatementFile(empty),
      (e: unknown) => {
        assert.match((e as FinError).message, /vazio/i);
        return true;
      },
    );
  });

  test("um arquivo dentro do tmp é aceito", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-import-file-"));
    const path = join(dir, "e.csv");
    writeFileSync(path, "Data;Valor;Descricao\n01/07/2026;-10,00;Mercado\n");
    assert.ok(readStatementFile(path).length > 0);
  });
});

describe("CLI", () => {
  interface Response {
    ok: boolean;
    error?: string;
    _exit: number;
    [k: string]: unknown;
  }

  function cli(dbPath: string, ...args: string[]): Response {
    const proc = spawnSync(process.execPath, [CLI, "--db", dbPath, ...args], {
      encoding: "utf8",
    });
    assert.ok(proc.stdout, `sem saída. stderr: ${proc.stderr}`);
    return { ...JSON.parse(proc.stdout), _exit: proc.status ?? -1 };
  }

  test("sem --apply faz prévia, sai 0 e não grava", () => {
    const { db, path, userId } = withUser();
    db.close();
    const r = cli(path, "--user-id", String(userId), "--file", OFX_BANK);
    assert.equal(r.ok, true);
    assert.equal(r._exit, 0);
    assert.equal(r.applied, false);
    assert.equal(r.new_count, 6);

    const check = connect(path);
    assert.equal(countTx(check, userId), 0);
    check.close();
  });

  test("--apply grava e sai 0", () => {
    const { db, path, userId } = withUser();
    db.close();
    const r = cli(path, "--user-id", String(userId), "--file", CSV_NUBANK, "--apply");
    assert.equal(r.ok, true);
    assert.equal(r.applied, true);
    assert.equal(r.created_count, 5);

    const check = connect(path);
    assert.equal(countTx(check, userId), 5);
    check.close();
    // Segunda passada pelo CLI: nada novo.
    const again = cli(path, "--user-id", String(userId), "--file", CSV_NUBANK, "--apply");
    assert.equal(again.created_count, 0);
  });

  test("erro sai 1 com {ok:false,error} em português", () => {
    const { db, path, userId } = withUser();
    db.close();
    const missing = cli(path, "--file", OFX_BANK);
    assert.equal(missing.ok, false);
    assert.equal(missing._exit, 1);
    assert.match(missing.error!, /--user-id/);

    const badId = cli(path, "--user-id", "abc", "--file", OFX_BANK);
    assert.equal(badId._exit, 1);

    const badFormat = cli(path, "--user-id", String(userId), "--file", OFX_BANK, "--format", "xml");
    assert.equal(badFormat._exit, 1);
    assert.match(badFormat.error!, /Formato inválido/);

    const unknownOption = cli(path, "--user-id", String(userId), "--nope");
    assert.equal(unknownOption._exit, 1);
    assert.match(unknownOption.error!, /Opção inválida/);
  });

  test("--json devolve todas as linhas sem corte", () => {
    const { db, path, userId } = withUser();
    db.close();
    const r = cli(path, "--user-id", String(userId), "--file", OFX_BANK, "--json");
    assert.equal((r.rows as unknown[]).length, 6);
    assert.equal(r.rows_truncated, false);
  });
});
