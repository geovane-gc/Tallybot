/**
 * Camada de dados do agente financeiro.
 *
 * Decisões que valem conhecer antes de mexer aqui:
 *
 * - Dinheiro é inteiro em centavos, com tipo `Centavos` marcado. Nunca float:
 *   `27.50` viraria `27.499999...` em algum ponto e um relatório mensal
 *   acumularia erro. A marca no tipo impede passar reais onde se espera
 *   centavos, que é o erro mais fácil de cometer aqui.
 *
 * - Datas são strings `YYYY-MM-DD` interpretadas em `America/Sao_Paulo`. O
 *   container roda em UTC, então pegar "hoje" sem fuso registraria um gasto das
 *   22h de terça como quarta. Toda aritmética de calendário usa `Date.UTC` em
 *   cima dos componentes, nunca o fuso local do processo.
 *
 * - Migrations são idempotentes e versionadas em `MIGRATIONS`; `migrate()` pode
 *   rodar em todo boot e aplica só o que falta.
 *
 * - Zero dependências: `node:sqlite` é embutido, então não há `node_modules`,
 *   build step nem módulo nativo para compilar.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Centavos = number & { readonly __marca: unique symbol };

export type TipoLancamento = "despesa" | "receita" | "transferencia";
export type TipoConta =
  | "conta"
  | "cartao"
  | "dinheiro"
  | "poupanca"
  | "investimento"
  | "voucher";
export type TipoCategoria = "despesa" | "receita" | "ambos";
export type Frequencia = "mensal" | "semanal" | "anual";
export type SituacaoOrcamento = "ok" | "atencao" | "estourado";

export const TIPOS_LANCAMENTO: readonly TipoLancamento[] = [
  "despesa",
  "receita",
  "transferencia",
];
export const TIPOS_CONTA: readonly TipoConta[] = [
  "conta",
  "cartao",
  "dinheiro",
  "poupanca",
  "investimento",
  "voucher",
];

export const DEFAULT_DB =
  process.env.FIN_DB ?? "/opt/data/financas/financas.db";

export const SCHEMA_VERSION_ATUAL = 1;

const TZ = "America/Sao_Paulo";

/**
 * Erro esperado, com mensagem apresentável ao usuário final.
 *
 * A CLI transforma isto em `{"ok": false, "erro": "..."}` e o agente repassa o
 * texto para o Telegram. Por isso as mensagens são em português e falam de
 * dinheiro, não de SQL.
 */
export class FinErro extends Error {}

export const cent = (n: number): Centavos => n as Centavos;

/** Data de hoje em São Paulo, como `YYYY-MM-DD`. */
export function hoje(): string {
  // `en-CA` formata como YYYY-MM-DD, e `timeZone` resolve o fuso sem depender
  // do TZ do processo.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Timestamp ISO com offset de São Paulo, para as colunas de auditoria. */
export function agora(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = (t: string) => partes.find((x) => x.type === t)!.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}-03:00`;
}

interface Ymd {
  ano: number;
  mes: number;
  dia: number;
}

function partesData(iso: string): Ymd {
  const [ano, mes, dia] = iso.split("-").map(Number);
  return { ano, mes, dia };
}

function montarData(ano: number, mes: number, dia: number, original: unknown): string {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  // Date.UTC normaliza silenciosamente (31/02 vira 03/03); comparar de volta é
  // o que detecta a data inexistente.
  if (
    d.getUTCFullYear() !== ano ||
    d.getUTCMonth() !== mes - 1 ||
    d.getUTCDate() !== dia
  ) {
    throw new FinErro(`Data inexistente: ${String(original)}`);
  }
  return formatarUtc(d);
}

function formatarUtc(d: Date): string {
  const mes = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mes}-${dia}`;
}

function comoUtc(iso: string): Date {
  const { ano, mes, dia } = partesData(iso);
  return new Date(Date.UTC(ano, mes - 1, dia));
}

export function somarDias(iso: string, dias: number): string {
  const d = comoUtc(iso);
  d.setUTCDate(d.getUTCDate() + dias);
  return formatarUtc(d);
}

/**
 * Avança N meses preservando o dia quando possível.
 *
 * 31/01 + 1 mês = 28/02 (ou 29 em ano bissexto), que é o comportamento que
 * parcelamento de cartão espera.
 */
export function somarMeses(iso: string, meses: number): string {
  if (meses === 0) return iso;
  const { ano, mes, dia } = partesData(iso);
  const total = mes - 1 + meses;
  const novoAno = ano + Math.floor(total / 12);
  const novoMes = ((total % 12) + 12) % 12 + 1;
  const ultimo = ultimoDiaDoMes(novoAno, novoMes);
  return montarData(novoAno, novoMes, Math.min(dia, ultimo), iso);
}

export function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** Dia da semana, 0 = domingo. */
function diaDaSemana(iso: string): number {
  return comoUtc(iso).getUTCDay();
}

export function mesDe(iso: string): string {
  return iso.slice(0, 7);
}

/** Minúsculas sem acento, para casar nomes digitados de qualquer jeito. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Converte a data recebida do agente para `YYYY-MM-DD`.
 *
 * Aceita ISO, `DD/MM`, `DD/MM/YYYY` e os relativos comuns em português. O
 * agente resolve parte das expressões, mas tratar os casos frequentes aqui
 * evita que um modelo mais fraco erre aritmética de calendário — e erro de data
 * em finanças contamina todo relatório.
 */
export function parseData(valor?: string | null): string {
  if (valor === undefined || valor === null || String(valor).trim() === "") {
    return hoje();
  }

  const texto = normalizar(String(valor));

  const relativos: Record<string, number> = {
    hoje: 0,
    agora: 0,
    ontem: -1,
    anteontem: -2,
    amanha: 1,
    "depois de amanha": 2,
  };
  if (texto in relativos) return somarDias(hoje(), relativos[texto]);

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (m) return montarData(+m[1], +m[2], +m[3], valor);

  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(texto);
  if (m) {
    const ano = +m[3] < 100 ? +m[3] + 2000 : +m[3];
    return montarData(ano, +m[2], +m[1], valor);
  }

  // DD/MM sem ano: assume o corrente, mas se cair mais de um mês no futuro,
  // entende que era do ano passado (o caso de lançar "28/12" já em janeiro).
  m = /^(\d{1,2})[/\-.](\d{1,2})$/.exec(texto);
  if (m) {
    const ref = hoje();
    const candidata = montarData(partesData(ref).ano, +m[2], +m[1], valor);
    if (candidata > somarDias(ref, 31)) {
      return montarData(partesData(ref).ano - 1, +m[2], +m[1], valor);
    }
    return candidata;
  }

  m = /^dia (\d{1,2})$/.exec(texto);
  if (m) {
    const { ano, mes } = partesData(hoje());
    return montarData(ano, mes, +m[1], valor);
  }

  throw new FinErro(
    `Não entendi a data ${JSON.stringify(valor)}. Use YYYY-MM-DD, DD/MM ou 'hoje'/'ontem'.`,
  );
}

/**
 * Converte valor monetário em centavos.
 *
 * Aceita o que um modelo produz a partir de português falado: `27`, `27.5`,
 * `"27,50"`, `"R$ 1.234,56"`, `"1,2k"`, `"30 reais"`.
 *
 * A regra que importa: com vírgula E ponto, a vírgula é o separador decimal
 * (padrão brasileiro). Só com ponto, decide pelo formato — `1.234` é mil
 * duzentos e trinta e quatro, `27.50` é vinte e sete e meio.
 */
export function parseValor(valor: unknown): Centavos {
  let centavos: number;

  if (typeof valor === "boolean" || valor === null || valor === undefined) {
    throw new FinErro("Valor inválido.");
  }

  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) throw new FinErro("Valor inválido.");
    centavos = Math.round(valor * 100);
  } else {
    let texto = normalizar(String(valor))
      .replaceAll("r$", "")
      .replaceAll("reais", "")
      .replaceAll("real", "")
      .replaceAll(" ", "")
      .trim();

    if (!texto) throw new FinErro("Valor não informado.");

    let multiplicador = 1;
    if (texto.endsWith("mil")) {
      multiplicador = 1000;
      texto = texto.slice(0, -3);
    } else if (texto.endsWith("k")) {
      multiplicador = 1000;
      texto = texto.slice(0, -1);
    }

    const negativo = texto.startsWith("-");
    texto = texto.replace(/^[-+]+/, "");

    const temVirgula = texto.includes(",");
    const pontos = (texto.match(/\./g) ?? []).length;

    if (temVirgula && pontos > 0) {
      texto = texto.replaceAll(".", "").replace(",", ".");
    } else if (temVirgula) {
      texto = texto.replace(",", ".");
    } else if (pontos === 1) {
      const [inteiro, frac] = texto.split(".");
      // 1.234 = milhar; 27.5 e 27.50 = decimal
      if (frac.length === 3 && inteiro.length <= 3) texto = inteiro + frac;
    } else if (pontos > 1) {
      texto = texto.replaceAll(".", "");
    }

    const numero = Number(texto);
    if (!Number.isFinite(numero) || texto === "") {
      throw new FinErro(`Não consegui ler o valor ${JSON.stringify(valor)}.`);
    }
    centavos = Math.round(numero * multiplicador * 100);
    if (negativo) centavos = -centavos;
  }

  if (centavos === 0) throw new FinErro("O valor precisa ser maior que zero.");
  return cent(Math.abs(centavos));
}

/** Formata centavos como `R$ 1.234,56`. */
export function fmtBrl(centavos: number): string {
  const sinal = centavos < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(centavos));
  const inteiro = Math.floor(abs / 100);
  const resto = abs % 100;
  const milhar = inteiro.toLocaleString("pt-BR");
  return `${sinal}R$ ${milhar},${String(resto).padStart(2, "0")}`;
}

export interface Periodo {
  inicio: string;
  fim: string;
  rotulo: string;
}

/**
 * Traduz um período nomeado em `{inicio, fim, rotulo}`.
 *
 * Aceita: hoje, ontem, semana, semana-passada, mes, mes-passado, mes-completo,
 * ano, ano-passado, tudo, `Nd` (últimos N dias) e `YYYY-MM`.
 */
export function intervaloPeriodo(periodo?: string, referencia?: string): Periodo {
  const ref = referencia ?? hoje();
  const p = normalizar(periodo ?? "mes");
  const { ano, mes } = partesData(ref);

  // Semana começando na segunda, como no calendário brasileiro.
  const offsetSegunda = (diaDaSemana(ref) + 6) % 7;

  switch (p) {
    case "hoje":
    case "dia":
      return { inicio: ref, fim: ref, rotulo: "hoje" };
    case "ontem": {
      const d = somarDias(ref, -1);
      return { inicio: d, fim: d, rotulo: "ontem" };
    }
    case "semana":
    case "esta-semana":
      return {
        inicio: somarDias(ref, -offsetSegunda),
        fim: ref,
        rotulo: "esta semana",
      };
    case "semana-passada":
    case "ultima-semana": {
      const inicio = somarDias(ref, -offsetSegunda - 7);
      return { inicio, fim: somarDias(inicio, 6), rotulo: "semana passada" };
    }
    case "mes":
    case "este-mes":
      return {
        inicio: montarData(ano, mes, 1, p),
        fim: ref,
        rotulo: "este mês",
      };
    case "mes-passado":
    case "ultimo-mes": {
      const fim = somarDias(montarData(ano, mes, 1, p), -1);
      const f = partesData(fim);
      return {
        inicio: montarData(f.ano, f.mes, 1, p),
        fim,
        rotulo: "mês passado",
      };
    }
    case "mes-completo":
    case "mes-inteiro":
      return {
        inicio: montarData(ano, mes, 1, p),
        fim: montarData(ano, mes, ultimoDiaDoMes(ano, mes), p),
        rotulo: "mês corrente",
      };
    case "ano":
    case "este-ano":
      return { inicio: `${ano}-01-01`, fim: ref, rotulo: "este ano" };
    case "ano-passado":
      return {
        inicio: `${ano - 1}-01-01`,
        fim: `${ano - 1}-12-31`,
        rotulo: "ano passado",
      };
    case "tudo":
    case "todos":
    case "sempre":
      return { inicio: "0001-01-01", fim: ref, rotulo: "todo o histórico" };
  }

  let m = /^(\d+)\s*d(ias)?$/.exec(p);
  if (m) {
    const n = +m[1];
    return {
      inicio: somarDias(ref, -(n - 1)),
      fim: ref,
      rotulo: `últimos ${n} dias`,
    };
  }

  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) {
    const a = +m[1];
    const mm = +m[2];
    if (mm < 1 || mm > 12) throw new FinErro(`Mês inválido em ${JSON.stringify(periodo)}.`);
    return {
      inicio: `${m[1]}-${m[2]}-01`,
      fim: montarData(a, mm, ultimoDiaDoMes(a, mm), p),
      rotulo: `${m[2]}/${m[1]}`,
    };
  }

  throw new FinErro(
    `Período ${JSON.stringify(periodo)} não reconhecido. Use hoje, semana, mes, ` +
      `mes-passado, 30d, ano ou YYYY-MM.`,
  );
}

export function mesValido(mes: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(mes);
}

const MIGRATIONS: readonly { versao: number; sql: string }[] = [
  {
    versao: 1,
    sql: `
    CREATE TABLE contas (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        nome           TEXT    NOT NULL UNIQUE,
        tipo           TEXT    NOT NULL DEFAULT 'conta'
                         CHECK (tipo IN ('conta','cartao','dinheiro',
                                         'poupanca','investimento','voucher')),
        instituicao    TEXT,
        dia_fechamento INTEGER CHECK (dia_fechamento BETWEEN 1 AND 31),
        dia_vencimento INTEGER CHECK (dia_vencimento BETWEEN 1 AND 31),
        limite_centavos INTEGER,
        saldo_inicial_centavos INTEGER NOT NULL DEFAULT 0,
        ativa          INTEGER NOT NULL DEFAULT 1,
        criada_em      TEXT    NOT NULL
    );

    CREATE TABLE categorias (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        nome      TEXT    NOT NULL,
        parent_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
        tipo      TEXT    NOT NULL DEFAULT 'despesa'
                    CHECK (tipo IN ('despesa','receita','ambos')),
        emoji     TEXT,
        ativa     INTEGER NOT NULL DEFAULT 1,
        UNIQUE (nome, parent_id)
    );

    CREATE TABLE recorrentes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        descricao      TEXT    NOT NULL,
        tipo           TEXT    NOT NULL DEFAULT 'despesa'
                         CHECK (tipo IN ('despesa','receita')),
        valor_centavos INTEGER NOT NULL,
        categoria_id   INTEGER REFERENCES categorias(id),
        conta_id       INTEGER REFERENCES contas(id),
        frequencia     TEXT    NOT NULL DEFAULT 'mensal'
                         CHECK (frequencia IN ('mensal','semanal','anual')),
        dia            INTEGER NOT NULL DEFAULT 1,
        proxima_data   TEXT    NOT NULL,
        fim            TEXT,
        ativa          INTEGER NOT NULL DEFAULT 1,
        criada_em      TEXT    NOT NULL
    );

    CREATE TABLE lancamentos (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo             TEXT    NOT NULL
                           CHECK (tipo IN ('despesa','receita','transferencia')),
        valor_centavos   INTEGER NOT NULL CHECK (valor_centavos > 0),
        descricao        TEXT    NOT NULL,
        data             TEXT    NOT NULL,
        categoria_id     INTEGER REFERENCES categorias(id),
        conta_id         INTEGER REFERENCES contas(id),
        conta_destino_id INTEGER REFERENCES contas(id),
        observacao       TEXT,
        origem           TEXT    NOT NULL DEFAULT 'telegram',
        recorrente_id    INTEGER REFERENCES recorrentes(id) ON DELETE SET NULL,
        parcela_num      INTEGER,
        parcela_total    INTEGER,
        grupo_parcelas   TEXT,
        criado_em        TEXT    NOT NULL,
        atualizado_em    TEXT    NOT NULL,
        CHECK (tipo <> 'transferencia' OR conta_destino_id IS NOT NULL),
        CHECK (conta_destino_id IS NULL OR conta_destino_id <> conta_id)
    );

    CREATE INDEX idx_lanc_data      ON lancamentos(data);
    CREATE INDEX idx_lanc_categoria ON lancamentos(categoria_id, data);
    CREATE INDEX idx_lanc_conta     ON lancamentos(conta_id, data);
    CREATE INDEX idx_lanc_tipo      ON lancamentos(tipo, data);
    CREATE INDEX idx_lanc_grupo     ON lancamentos(grupo_parcelas);

    CREATE TABLE tags (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL UNIQUE
    );

    CREATE TABLE lancamento_tags (
        lancamento_id INTEGER NOT NULL
                        REFERENCES lancamentos(id) ON DELETE CASCADE,
        tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (lancamento_id, tag_id)
    );

    CREATE TABLE orcamentos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        categoria_id   INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
        mes            TEXT,
        limite_centavos INTEGER NOT NULL CHECK (limite_centavos > 0),
        alerta_pct     INTEGER NOT NULL DEFAULT 80
                         CHECK (alerta_pct BETWEEN 1 AND 100),
        criado_em      TEXT    NOT NULL,
        UNIQUE (categoria_id, mes)
    );

    CREATE TABLE metas (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        nome               TEXT    NOT NULL UNIQUE,
        valor_alvo_centavos INTEGER NOT NULL CHECK (valor_alvo_centavos > 0),
        valor_atual_centavos INTEGER NOT NULL DEFAULT 0,
        prazo              TEXT,
        ativa              INTEGER NOT NULL DEFAULT 1,
        criada_em          TEXT    NOT NULL
    );

    CREATE TABLE alertas_enviados (
        chave      TEXT NOT NULL,
        mes        TEXT NOT NULL,
        nivel      TEXT NOT NULL,
        enviado_em TEXT NOT NULL,
        PRIMARY KEY (chave, mes, nivel)
    );

    CREATE TABLE config (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
    );

    CREATE TABLE schema_version (
        versao      INTEGER PRIMARY KEY,
        aplicado_em TEXT NOT NULL
    );

    CREATE VIEW v_lancamentos AS
    SELECT
        l.id, l.tipo, l.valor_centavos, l.descricao, l.data,
        l.observacao, l.origem, l.parcela_num, l.parcela_total,
        l.grupo_parcelas, l.recorrente_id, l.criado_em, l.atualizado_em,
        l.categoria_id,
        COALESCE(c.nome, 'Sem categoria') AS categoria,
        cp.nome                           AS categoria_pai,
        c.emoji                           AS categoria_emoji,
        l.conta_id,
        COALESCE(ct.nome, 'Sem conta')    AS conta,
        ct.tipo                           AS conta_tipo,
        l.conta_destino_id,
        ctd.nome                          AS conta_destino
    FROM lancamentos l
    LEFT JOIN categorias c   ON c.id  = l.categoria_id
    LEFT JOIN categorias cp  ON cp.id = c.parent_id
    LEFT JOIN contas ct      ON ct.id = l.conta_id
    LEFT JOIN contas ctd     ON ctd.id = l.conta_destino_id;
    `,
  },
];

/** Taxonomia inicial, no vocabulário de quem fala português do Brasil. */
const CATEGORIAS_SEED: readonly {
  nome: string;
  emoji: string;
  tipo: TipoCategoria;
  subs: readonly string[];
}[] = [
  { nome: "Alimentação", emoji: "🍽️", tipo: "despesa", subs: ["Mercado", "Restaurante", "Delivery", "Padaria", "Café"] },
  { nome: "Transporte", emoji: "🚗", tipo: "despesa", subs: ["Uber/99", "Combustível", "Estacionamento", "Transporte público", "Manutenção"] },
  { nome: "Moradia", emoji: "🏠", tipo: "despesa", subs: ["Aluguel", "Condomínio", "Luz", "Água", "Gás", "Internet", "IPTU"] },
  { nome: "Saúde", emoji: "💊", tipo: "despesa", subs: ["Farmácia", "Consulta", "Exame", "Plano de saúde", "Academia"] },
  { nome: "Lazer", emoji: "🎉", tipo: "despesa", subs: ["Streaming", "Bar", "Cinema", "Viagem", "Jogos", "Eventos"] },
  { nome: "Compras", emoji: "🛍️", tipo: "despesa", subs: ["Roupas", "Eletrônicos", "Casa", "Presentes"] },
  { nome: "Educação", emoji: "📚", tipo: "despesa", subs: ["Curso", "Livros", "Mensalidade", "Certificação"] },
  { nome: "Assinaturas", emoji: "🔁", tipo: "despesa", subs: ["Software", "Streaming", "Nuvem", "Telefonia"] },
  { nome: "Serviços", emoji: "🔧", tipo: "despesa", subs: ["Cabeleireiro", "Lavanderia", "Reparos", "Assinatura profissional"] },
  { nome: "Impostos e taxas", emoji: "🧾", tipo: "despesa", subs: ["Imposto", "Tarifa bancária", "Multa", "Juros"] },
  { nome: "Pets", emoji: "🐾", tipo: "despesa", subs: ["Ração", "Veterinário", "Petshop"] },
  { nome: "Família", emoji: "👨‍👩‍👧", tipo: "despesa", subs: ["Filhos", "Escola", "Mesada", "Ajuda familiar"] },
  { nome: "Investimentos", emoji: "📈", tipo: "ambos", subs: ["Aporte", "Resgate", "Dividendos"] },
  { nome: "Dívidas", emoji: "💳", tipo: "despesa", subs: ["Fatura de cartão", "Empréstimo", "Financiamento"] },
  { nome: "Outros", emoji: "❓", tipo: "ambos", subs: [] },
  { nome: "Salário", emoji: "💰", tipo: "receita", subs: ["Salário", "13º", "Férias", "Bônus"] },
  { nome: "Renda extra", emoji: "💵", tipo: "receita", subs: ["Freelance", "Venda", "Aluguel recebido", "Reembolso", "Cashback"] },
];

export type Db = DatabaseSync;

/**
 * Abre a conexão com os pragmas que este bot precisa.
 *
 * WAL porque o cron pode ler enquanto uma conversa escreve; `foreign_keys`
 * porque as FKs do schema só valem se ligadas por conexão.
 */
export function conectar(caminho?: string): Db {
  const alvo = caminho ?? DEFAULT_DB;
  mkdirSync(dirname(resolve(alvo)), { recursive: true });

  const db = new DatabaseSync(alvo);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 15000");
  return db;
}

/** Executa `fn` numa transação, revertendo em caso de erro. */
export function transacao<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function versaoAtual(db: Db): number {
  const tabela = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get();
  if (!tabela) return 0;
  const row = db.prepare("SELECT MAX(versao) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  return Number(row?.v ?? 0);
}

/** Aplica as migrations pendentes. Devolve as versões aplicadas. */
export function migrate(db: Db): number[] {
  const atual = versaoAtual(db);
  const aplicadas: number[] = [];
  for (const { versao, sql } of MIGRATIONS) {
    if (versao <= atual) continue;
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_version (versao, aplicado_em) VALUES (?, ?)",
    ).run(versao, agora());
    aplicadas.push(versao);
  }
  return aplicadas;
}

export interface ResultadoSeed {
  categorias: number;
  subcategorias: number;
  contas: number;
}

/**
 * Popula categorias, conta padrão e config inicial.
 *
 * Só insere o que falta, para não atropelar quem já renomeou ou apagou algo.
 */
export function semear(db: Db): ResultadoSeed {
  const criadas: ResultadoSeed = { categorias: 0, subcategorias: 0, contas: 0 };

  transacao(db, () => {
    for (const { nome, emoji, tipo, subs } of CATEGORIAS_SEED) {
      const existente = db
        .prepare("SELECT id FROM categorias WHERE parent_id IS NULL AND nome = ?")
        .get(nome) as { id: number } | undefined;

      let paiId: number;
      if (existente) {
        paiId = existente.id;
      } else {
        const info = db
          .prepare(
            "INSERT INTO categorias (nome, parent_id, tipo, emoji) VALUES (?, NULL, ?, ?)",
          )
          .run(nome, tipo, emoji);
        paiId = Number(info.lastInsertRowid);
        criadas.categorias++;
      }

      for (const sub of subs) {
        const jaTem = db
          .prepare("SELECT 1 FROM categorias WHERE nome = ? AND parent_id = ?")
          .get(sub, paiId);
        if (!jaTem) {
          db.prepare(
            "INSERT INTO categorias (nome, parent_id, tipo, emoji) VALUES (?, ?, ?, NULL)",
          ).run(sub, paiId, tipo);
          criadas.subcategorias++;
        }
      }
    }

    // Uma conta padrão, para que lançar despesa funcione sem configurar nada.
    if (!db.prepare("SELECT 1 FROM contas LIMIT 1").get()) {
      db.prepare("INSERT INTO contas (nome, tipo, criada_em) VALUES (?, ?, ?)").run(
        "Carteira",
        "dinheiro",
        agora(),
      );
      criadas.contas++;
    }

    for (const [chave, valor] of [
      ["moeda", "BRL"],
      ["timezone", TZ],
      ["conta_padrao", "Carteira"],
    ]) {
      db.prepare("INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)").run(
        chave,
        valor,
      );
    }
  });

  return criadas;
}

export function init(caminho?: string) {
  const db = conectar(caminho);
  try {
    const aplicadas = migrate(db);
    const seed = semear(db);
    return {
      banco: caminho ?? DEFAULT_DB,
      versao_schema: versaoAtual(db),
      migrations_aplicadas: aplicadas,
      seed,
    };
  } finally {
    db.close();
  }
}

export function getConfig(db: Db, chave: string, padrao?: string): string | undefined {
  const row = db.prepare("SELECT valor FROM config WHERE chave = ?").get(chave) as
    | { valor: string }
    | undefined;
  return row ? row.valor : padrao;
}

export function setConfig(db: Db, chave: string, valor: string): void {
  db.prepare(
    "INSERT INTO config (chave, valor) VALUES (?, ?) " +
      "ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
  ).run(chave, valor);
}

interface LinhaCategoria {
  id: number;
  nome: string;
  parent_id: number | null;
}

/**
 * Encontra a categoria pelo nome, tolerando acento, caixa e plural.
 *
 * Casa primeiro em subcategoria (mais específica: "Delivery" antes de
 * "Alimentação"), depois em raiz, e por último por conteúdo. Com `criar`,
 * cadastra sob "Outros" em vez de falhar — perder um lançamento porque a
 * categoria não existia seria pior que ter uma categoria a mais.
 */
export function resolverCategoria(
  db: Db,
  nome?: string | null,
  criar = false,
): number | null {
  if (!nome || !String(nome).trim()) return null;

  const alvo = normalizar(String(nome));
  const linhas = db
    .prepare("SELECT id, nome, parent_id FROM categorias WHERE ativa = 1")
    .all() as LinhaCategoria[];

  const exatos = linhas.filter((r) => normalizar(r.nome) === alvo);
  if (exatos.length) {
    exatos.sort((a, b) => (a.parent_id === null ? 1 : 0) - (b.parent_id === null ? 1 : 0));
    return exatos[0].id;
  }

  const variantes = new Set([alvo, alvo.replace(/s$/, ""), `${alvo}s`]);
  for (const r of linhas) {
    if (variantes.has(normalizar(r.nome))) return r.id;
  }

  const parciais = linhas.filter((r) => {
    const n = normalizar(r.nome);
    return n.includes(alvo) || alvo.includes(n);
  });
  if (parciais.length === 1) return parciais[0].id;
  if (parciais.length > 1) {
    parciais.sort((a, b) => {
      const folha = (a.parent_id === null ? 1 : 0) - (b.parent_id === null ? 1 : 0);
      return folha !== 0 ? folha : a.nome.length - b.nome.length;
    });
    return parciais[0].id;
  }

  if (criar) {
    const pai = db
      .prepare("SELECT id FROM categorias WHERE nome = 'Outros' AND parent_id IS NULL")
      .get() as { id: number } | undefined;
    const info = db
      .prepare("INSERT INTO categorias (nome, parent_id, tipo) VALUES (?, ?, 'ambos')")
      .run(String(nome).trim().slice(0, 60), pai ? pai.id : null);
    return Number(info.lastInsertRowid);
  }

  throw new FinErro(
    `Categoria ${JSON.stringify(nome)} não existe. Rode \`categoria list\` para ver as disponíveis.`,
  );
}

/** Encontra a conta pelo nome; sem nome, cai na conta padrão. */
export function resolverConta(
  db: Db,
  nome?: string | null,
  usarPadrao = true,
): number | null {
  if (!nome || !String(nome).trim()) {
    if (!usarPadrao) return null;
    const padrao = getConfig(db, "conta_padrao", "Carteira")!;
    const row = db
      .prepare("SELECT id FROM contas WHERE nome = ? AND ativa = 1")
      .get(padrao) as { id: number } | undefined;
    if (row) return row.id;
    const qualquer = db
      .prepare("SELECT id FROM contas WHERE ativa = 1 ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    return qualquer ? qualquer.id : null;
  }

  const alvo = normalizar(String(nome));
  const linhas = db.prepare("SELECT id, nome FROM contas WHERE ativa = 1").all() as {
    id: number;
    nome: string;
  }[];

  for (const r of linhas) {
    if (normalizar(r.nome) === alvo) return r.id;
  }

  const parciais = linhas.filter((r) => {
    const n = normalizar(r.nome);
    return n.includes(alvo) || alvo.includes(n);
  });
  if (parciais.length === 1) return parciais[0].id;
  if (parciais.length > 1) {
    throw new FinErro(
      `Mais de uma conta casa com ${JSON.stringify(nome)}: ` +
        `${parciais.map((r) => r.nome).join(", ")}. Seja específico.`,
    );
  }

  throw new FinErro(
    `Conta ${JSON.stringify(nome)} não existe. Rode \`conta list\`, ou crie com \`conta add\`.`,
  );
}

/** `Alimentação > Delivery`, para exibição. */
export function nomeCategoriaCompleto(db: Db, categoriaId?: number | null): string {
  if (!categoriaId) return "Sem categoria";
  const row = db
    .prepare(
      "SELECT c.nome AS nome, p.nome AS pai FROM categorias c " +
        "LEFT JOIN categorias p ON p.id = c.parent_id WHERE c.id = ?",
    )
    .get(categoriaId) as { nome: string; pai: string | null } | undefined;
  if (!row) return "Sem categoria";
  return row.pai ? `${row.pai} > ${row.nome}` : row.nome;
}

/**
 * A categoria e suas subcategorias.
 *
 * Filtrar por "Alimentação" tem que incluir o que foi lançado em "Delivery",
 * senão o orçamento da raiz nunca fecha com a soma das partes.
 */
export function idsCategoriaEFilhas(db: Db, categoriaId: number): number[] {
  const filhas = db
    .prepare("SELECT id FROM categorias WHERE parent_id = ?")
    .all(categoriaId) as { id: number }[];
  return [categoriaId, ...filhas.map((r) => r.id)];
}

export function tagsDe(db: Db, lancamentoId: number): string[] {
  const linhas = db
    .prepare(
      "SELECT t.nome FROM tags t JOIN lancamento_tags lt ON lt.tag_id = t.id " +
        "WHERE lt.lancamento_id = ? ORDER BY t.nome",
    )
    .all(lancamentoId) as { nome: string }[];
  return linhas.map((r) => r.nome);
}

/** Substitui as tags do lançamento. */
export function aplicarTags(db: Db, lancamentoId: number, tags: string[]): void {
  transacao(db, () => {
    db.prepare("DELETE FROM lancamento_tags WHERE lancamento_id = ?").run(lancamentoId);
    for (const tag of tags) {
      const nome = String(tag).trim().replace(/^#/, "");
      if (!nome) continue;
      db.prepare("INSERT OR IGNORE INTO tags (nome) VALUES (?)").run(nome);
      const row = db.prepare("SELECT id FROM tags WHERE nome = ?").get(nome) as {
        id: number;
      };
      db.prepare(
        "INSERT OR IGNORE INTO lancamento_tags (lancamento_id, tag_id) VALUES (?, ?)",
      ).run(lancamentoId, row.id);
    }
  });
}

export interface LancamentoView {
  id: number;
  tipo: TipoLancamento;
  valor_centavos: number;
  descricao: string;
  data: string;
  observacao: string | null;
  origem: string;
  parcela_num: number | null;
  parcela_total: number | null;
  grupo_parcelas: string | null;
  recorrente_id: number | null;
  criado_em: string;
  atualizado_em: string;
  categoria_id: number | null;
  categoria: string;
  categoria_pai: string | null;
  categoria_emoji: string | null;
  conta_id: number | null;
  conta: string;
  conta_tipo: TipoConta | null;
  conta_destino_id: number | null;
  conta_destino: string | null;
}

export interface LancamentoSaida extends LancamentoView {
  valor: number;
  valor_fmt: string;
  tags: string[];
  categoria_completa: string;
  parcela?: string;
}

/** Row da view para objeto pronto para virar JSON. */
export function dictLancamento(db: Db, row: LancamentoView): LancamentoSaida {
  const saida: LancamentoSaida = {
    ...row,
    valor: row.valor_centavos / 100,
    valor_fmt: fmtBrl(row.valor_centavos),
    tags: tagsDe(db, row.id),
    categoria_completa: row.categoria_pai
      ? `${row.categoria_pai} > ${row.categoria}`
      : row.categoria,
  };
  if (row.parcela_total) {
    saida.parcela = `${row.parcela_num}/${row.parcela_total}`;
  }
  return saida;
}
