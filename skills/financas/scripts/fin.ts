#!/usr/bin/env node
/**
 * CLI de controle financeiro — a ferramenta que o agente do Telegram opera.
 *
 * Por que uma CLI única com subcomandos, e não vários scripts: o modelo que
 * dirige isso é um free tier. Um único ponto de entrada, argumentos nomeados e
 * saída sempre em JSON reduzem muito a chance de ele errar a chamada. Toda a
 * aritmética de dinheiro, calendário e orçamento vive aqui — o modelo decide
 * *o que* registrar, nunca *como* calcular.
 *
 * Contrato de saída, respeitado por todo subcomando:
 *
 *     sucesso  -> {"ok": true,  ...dados}      exit 0
 *     erro     -> {"ok": false, "erro": "..."} exit 1
 *
 * Uso:
 *     node fin.ts [--db CAMINHO] <subcomando> [opções]
 *
 * O caminho do banco vem de --db, da env FIN_DB, ou do default
 * /opt/data/financas/financas.db (dentro do container).
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  FinErro,
  TIPOS_CONTA,
  TIPOS_LANCAMENTO,
  agora,
  conectar,
  dictLancamento,
  fmtBrl,
  getConfig,
  hoje,
  idsCategoriaEFilhas,
  init,
  intervaloPeriodo,
  aplicarTags,
  mesDe,
  mesValido,
  migrate,
  nomeCategoriaCompleto,
  parseData,
  parseValor,
  resolverCategoria,
  resolverConta,
  semear,
  setConfig,
  somarDias,
  somarMeses,
  transacao,
  ultimoDiaDoMes,
  versaoAtual,
  SCHEMA_VERSION_ATUAL,
  type Db,
  type LancamentoSaida,
  type LancamentoView,
  type Periodo,
  type SituacaoOrcamento,
  type TipoConta,
  type TipoLancamento,
} from "./db.ts";

type Args = Record<string, string | boolean | undefined>;
type Saida = Record<string, unknown>;

const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" ? v : undefined;
};
const num = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new FinErro(`--${k} precisa ser um número inteiro.`);
  return n;
};
const flag = (a: Args, k: string): boolean => a[k] === true;

function comoTipoLancamento(v: string | undefined, padrao?: TipoLancamento) {
  if (v === undefined) {
    if (padrao) return padrao;
    return undefined;
  }
  if (!TIPOS_LANCAMENTO.includes(v as TipoLancamento)) {
    throw new FinErro(`Tipo inválido: ${v}. Use despesa, receita ou transferencia.`);
  }
  return v as TipoLancamento;
}

function soma(db: Db, sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>;
  const primeiro = row ? Object.values(row)[0] : 0;
  return Number(primeiro ?? 0);
}

function buscarLancamento(db: Db, id: number): LancamentoSaida {
  const row = db.prepare("SELECT * FROM v_lancamentos WHERE id = ?").get(id) as
    | LancamentoView
    | undefined;
  if (!row) throw new FinErro(`Não achei o lançamento #${id}.`);
  return dictLancamento(db, row);
}

function splitLista(valor?: string): string[] {
  if (!valor) return [];
  return valor
    .replaceAll(";", ",")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** `2026-08-03` -> `03/08`. Ano só quando não é o corrente. */
function br(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return ano === hoje().slice(0, 4) ? `${dia}/${mes}` : `${dia}/${mes}/${ano}`;
}

/** `2026-08-03` -> `03/08/2026`, para export: planilha precisa do ano. */
function brCompleto(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function cmdAdd(db: Db, a: Args): Saida {
  const tipo = comoTipoLancamento(str(a, "tipo"), "despesa")!;
  const valorTotal = parseValor(str(a, "valor"));
  const dataLanc = parseData(str(a, "data"));
  const descricao = (str(a, "descricao") ?? "").trim();
  if (!descricao) {
    throw new FinErro(
      "Descrição é obrigatória — é o que te faz reconhecer o gasto depois.",
    );
  }

  const contaId = resolverConta(db, str(a, "conta"));
  let contaDestinoId: number | null = null;
  let categoriaId: number | null = null;

  if (tipo === "transferencia") {
    const destino = str(a, "conta-destino");
    if (!destino) throw new FinErro("Transferência precisa de --conta-destino.");
    contaDestinoId = resolverConta(db, destino, false);
    if (contaDestinoId === contaId) {
      throw new FinErro("A conta de origem e destino são a mesma.");
    }
  } else {
    // `criar = true`: melhor cadastrar categoria nova do que rejeitar o
    // lançamento e o usuário perder o registro.
    categoriaId = resolverCategoria(db, str(a, "categoria"), true);
  }

  const parcelas = num(a, "parcelas") ?? 1;
  if (parcelas < 1 || parcelas > 120) {
    throw new FinErro("Número de parcelas fora do razoável (1 a 120).");
  }

  const ts = agora();
  const tags = splitLista(str(a, "tags"));
  const grupo = parcelas > 1 ? randomUUID().replaceAll("-", "").slice(0, 12) : null;

  // Divisão de parcelas sem perder centavo: o resto vai na primeira.
  const base = Math.floor(valorTotal / parcelas);
  const resto = valorTotal - base * parcelas;

  const criados: number[] = [];
  transacao(db, () => {
    const ins = db.prepare(
      "INSERT INTO lancamentos (" +
        "  tipo, valor_centavos, descricao, data, categoria_id, conta_id," +
        "  conta_destino_id, observacao, origem, parcela_num, parcela_total," +
        "  grupo_parcelas, criado_em, atualizado_em" +
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < parcelas; i++) {
      const info = ins.run(
        tipo,
        base + (i === 0 ? resto : 0),
        descricao,
        somarMeses(dataLanc, i),
        categoriaId,
        contaId,
        contaDestinoId,
        str(a, "obs") ?? null,
        str(a, "origem") ?? "telegram",
        parcelas > 1 ? i + 1 : null,
        parcelas > 1 ? parcelas : null,
        grupo,
        ts,
        ts,
      );
      criados.push(Number(info.lastInsertRowid));
    }
  });

  if (tags.length) {
    for (const id of criados) aplicarTags(db, id, tags);
  }

  // Só um dos dois campos vai na resposta: contexto de modelo free é caro, e
  // devolver o mesmo lançamento duas vezes não ajuda.
  const lancamentos = criados.map((id) => buscarLancamento(db, id));
  const saida: Saida = {
    id: criados[0],
    total_fmt: fmtBrl(valorTotal),
    parcelado: parcelas > 1,
  };
  if (parcelas > 1) {
    saida.parcelas = lancamentos;
    saida.valor_parcela_fmt = lancamentos[lancamentos.length - 1].valor_fmt;
  } else {
    saida.lancamento = lancamentos[0];
  }

  // O alerta viaja junto da confirmação, para o agente avisar sobre o orçamento
  // na mesma resposta, sem uma segunda chamada.
  if (tipo === "despesa" && categoriaId) {
    saida.orcamento = statusOrcamentoDaCategoria(db, categoriaId, mesDe(dataLanc));
  }

  return saida;
}

export function cmdEdit(db: Db, a: Args, posicionais: string[]): Saida {
  const id = Number(posicionais[0]);
  if (!Number.isInteger(id)) throw new FinErro("Informe o id do lançamento.");
  if (!db.prepare("SELECT 1 FROM lancamentos WHERE id = ?").get(id)) {
    throw new FinErro(`Não achei o lançamento #${id}.`);
  }

  const campos: string[] = [];
  const valores: unknown[] = [];

  if (str(a, "valor") !== undefined) {
    campos.push("valor_centavos = ?");
    valores.push(parseValor(str(a, "valor")));
  }
  if (str(a, "descricao") !== undefined) {
    campos.push("descricao = ?");
    valores.push(str(a, "descricao")!.trim());
  }
  if (str(a, "data") !== undefined) {
    campos.push("data = ?");
    valores.push(parseData(str(a, "data")));
  }
  if (str(a, "categoria") !== undefined) {
    campos.push("categoria_id = ?");
    valores.push(resolverCategoria(db, str(a, "categoria"), true));
  }
  if (str(a, "conta") !== undefined) {
    campos.push("conta_id = ?");
    valores.push(resolverConta(db, str(a, "conta")));
  }
  if (str(a, "tipo") !== undefined) {
    campos.push("tipo = ?");
    valores.push(comoTipoLancamento(str(a, "tipo"))!);
  }
  if (str(a, "obs") !== undefined) {
    campos.push("observacao = ?");
    valores.push(str(a, "obs"));
  }

  const temTags = str(a, "tags") !== undefined;
  if (!campos.length && !temTags) {
    throw new FinErro("Nada para alterar — informe ao menos um campo.");
  }

  if (campos.length) {
    campos.push("atualizado_em = ?");
    valores.push(agora(), id);
    db.prepare(`UPDATE lancamentos SET ${campos.join(", ")} WHERE id = ?`).run(
      ...(valores as never[]),
    );
  }

  if (temTags) aplicarTags(db, id, splitLista(str(a, "tags")));

  const lanc = buscarLancamento(db, id);
  const saida: Saida = { lancamento: lanc };
  if (lanc.tipo === "despesa" && lanc.categoria_id) {
    saida.orcamento = statusOrcamentoDaCategoria(db, lanc.categoria_id, mesDe(lanc.data));
  }
  return saida;
}

export function cmdRm(db: Db, a: Args, posicionais: string[]): Saida {
  const id = Number(posicionais[0]);
  if (!Number.isInteger(id)) throw new FinErro("Informe o id do lançamento.");
  const alvo = db.prepare("SELECT * FROM lancamentos WHERE id = ?").get(id) as
    | { grupo_parcelas: string | null }
    | undefined;
  if (!alvo) throw new FinErro(`Não achei o lançamento #${id}.`);

  let ids = [id];
  if (flag(a, "grupo") && alvo.grupo_parcelas) {
    ids = (
      db
        .prepare("SELECT id FROM lancamentos WHERE grupo_parcelas = ?")
        .all(alvo.grupo_parcelas) as { id: number }[]
    ).map((r) => r.id);
  }

  const removidos = ids.map((i) => buscarLancamento(db, i));
  transacao(db, () => {
    const del = db.prepare("DELETE FROM lancamentos WHERE id = ?");
    for (const i of ids) del.run(i);
  });

  return { removidos, quantidade: ids.length };
}

interface Filtro {
  where: string;
  params: unknown[];
  contexto: Saida;
}

function montarFiltros(db: Db, a: Args): Filtro {
  const clauses = ["1=1"];
  const params: unknown[] = [];
  const contexto: Saida = {};

  const periodo = str(a, "periodo");
  if (periodo) {
    const p = intervaloPeriodo(periodo);
    clauses.push("data BETWEEN ? AND ?");
    params.push(p.inicio, p.fim);
    contexto.periodo = p;
  }

  const categoria = str(a, "categoria");
  if (categoria) {
    const categoriaId = resolverCategoria(db, categoria)!;
    const ids = idsCategoriaEFilhas(db, categoriaId);
    clauses.push(`categoria_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    contexto.categoria = nomeCategoriaCompleto(db, categoriaId);
  }

  const conta = str(a, "conta");
  if (conta) {
    const contaId = resolverConta(db, conta, false);
    clauses.push("(conta_id = ? OR conta_destino_id = ?)");
    params.push(contaId, contaId);
    contexto.conta = conta;
  }

  const tipo = str(a, "tipo");
  if (tipo) {
    clauses.push("tipo = ?");
    params.push(comoTipoLancamento(tipo)!);
    contexto.tipo = tipo;
  }

  const tag = str(a, "tag");
  if (tag) {
    clauses.push(
      "id IN (SELECT lt.lancamento_id FROM lancamento_tags lt " +
        "JOIN tags t ON t.id = lt.tag_id WHERE t.nome = ?)",
    );
    params.push(tag.replace(/^#/, ""));
    contexto.tag = tag;
  }

  const texto = str(a, "texto");
  if (texto) {
    clauses.push("descricao LIKE ? COLLATE NOCASE");
    params.push(`%${texto}%`);
    contexto.texto = texto;
  }

  return { where: clauses.join(" AND "), params, contexto };
}

function formatarTotais(db: Db, where: string, params: unknown[]): Saida {
  const linhas = db
    .prepare(
      `SELECT tipo, SUM(valor_centavos) AS s, COUNT(*) AS n FROM v_lancamentos WHERE ${where} GROUP BY tipo`,
    )
    .all(...(params as never[])) as { tipo: TipoLancamento; s: number; n: number }[];

  const porTipo = new Map(linhas.map((r) => [r.tipo, r]));
  const out: Saida = {};
  for (const tipo of TIPOS_LANCAMENTO) {
    const info = porTipo.get(tipo);
    const centavos = Number(info?.s ?? 0);
    out[tipo] = {
      centavos,
      fmt: fmtBrl(centavos),
      quantidade: Number(info?.n ?? 0),
    };
  }
  return out;
}

export function cmdLs(db: Db, a: Args): Saida {
  const { where, params, contexto } = montarFiltros(db, a);
  const ordem = str(a, "ordem") === "asc" ? "data ASC, id ASC" : "data DESC, id DESC";
  const limite = Math.max(1, Math.min(num(a, "limite") ?? 30, 500));

  const linhas = db
    .prepare(`SELECT * FROM v_lancamentos WHERE ${where} ORDER BY ${ordem} LIMIT ?`)
    .all(...([...params, limite] as never[])) as LancamentoView[];

  const itens = linhas.map((r) => dictLancamento(db, r));
  const totais = formatarTotais(db, where, params);
  const quantidadeTotal = TIPOS_LANCAMENTO.reduce(
    (acc, t) => acc + Number((totais[t] as { quantidade: number }).quantidade),
    0,
  );

  return {
    filtro: contexto,
    quantidade_exibida: itens.length,
    quantidade_total: quantidadeTotal,
    totais,
    lancamentos: itens,
  };
}

export function cmdBusca(db: Db, a: Args, posicionais: string[]): Saida {
  const termo = (posicionais[0] ?? "").trim();
  if (!termo) throw new FinErro("Informe o que buscar.");
  const limite = Math.max(1, Math.min(num(a, "limite") ?? 20, 200));
  const like = `%${termo}%`;

  const linhas = db
    .prepare(
      "SELECT * FROM v_lancamentos WHERE descricao LIKE ? COLLATE NOCASE " +
        "OR IFNULL(observacao,'') LIKE ? COLLATE NOCASE " +
        "ORDER BY data DESC, id DESC LIMIT ?",
    )
    .all(like, like, limite) as LancamentoView[];

  const itens = linhas.map((r) => dictLancamento(db, r));
  const total = itens
    .filter((i) => i.tipo === "despesa")
    .reduce((acc, i) => acc + i.valor_centavos, 0);

  return {
    termo,
    quantidade: itens.length,
    total_despesas_fmt: fmtBrl(total),
    lancamentos: itens,
  };
}

/**
 * Saldo por conta e patrimônio líquido.
 *
 * Cartão de crédito aparece com saldo negativo quando há fatura em aberto — ler
 * "-R$ 800,00" como "você deve R$ 800,00" é o comportamento esperado.
 */
export function cmdSaldo(db: Db): Saida {
  const contas = db
    .prepare("SELECT * FROM contas WHERE ativa = 1 ORDER BY tipo, nome")
    .all() as {
    id: number;
    nome: string;
    tipo: TipoConta;
    instituicao: string | null;
    dia_vencimento: number | null;
    limite_centavos: number | null;
    saldo_inicial_centavos: number;
  }[];

  const mesAtual = mesDe(hoje());
  const resultado: Saida[] = [];
  let total = 0;
  let totalSemCartao = 0;

  for (const c of contas) {
    const receitas = soma(
      db,
      "SELECT SUM(valor_centavos) FROM lancamentos WHERE conta_id = ? AND tipo = 'receita'",
      [c.id],
    );
    const despesas = soma(
      db,
      "SELECT SUM(valor_centavos) FROM lancamentos WHERE conta_id = ? AND tipo = 'despesa'",
      [c.id],
    );
    const saiu = soma(
      db,
      "SELECT SUM(valor_centavos) FROM lancamentos WHERE conta_id = ? AND tipo = 'transferencia'",
      [c.id],
    );
    const entrou = soma(
      db,
      "SELECT SUM(valor_centavos) FROM lancamentos WHERE conta_destino_id = ? AND tipo = 'transferencia'",
      [c.id],
    );

    const saldo = c.saldo_inicial_centavos + receitas + entrou - despesas - saiu;

    const item: Saida = {
      id: c.id,
      nome: c.nome,
      tipo: c.tipo,
      instituicao: c.instituicao,
      saldo_centavos: saldo,
      saldo_fmt: fmtBrl(saldo),
    };

    if (c.tipo === "cartao") {
      const fatura = soma(
        db,
        "SELECT SUM(valor_centavos) FROM lancamentos " +
          "WHERE conta_id = ? AND tipo = 'despesa' AND substr(data,1,7) = ?",
        [c.id, mesAtual],
      );
      item.fatura_mes_centavos = fatura;
      item.fatura_mes_fmt = fmtBrl(fatura);
      item.dia_vencimento = c.dia_vencimento;
      if (c.limite_centavos) {
        item.limite_fmt = fmtBrl(c.limite_centavos);
        item.limite_usado_pct = Math.round((fatura * 1000) / c.limite_centavos) / 10;
      }
    } else {
      totalSemCartao += saldo;
    }

    total += saldo;
    resultado.push(item);
  }

  return {
    contas: resultado,
    total_centavos: total,
    total_fmt: fmtBrl(total),
    total_sem_cartao_fmt: fmtBrl(totalSemCartao),
  };
}

interface Agregado extends Saida {
  despesas_centavos: number;
  receitas_centavos: number;
  por_categoria: {
    categoria: string;
    emoji: string | null;
    total_centavos: number;
    total_fmt: string;
    quantidade: number;
    percentual: number;
  }[];
  maiores_gastos: LancamentoSaida[];
  quantidade: number;
}

/**
 * Números crus de um intervalo.
 *
 * Transferências ficam fora dos totais: mover dinheiro entre contas suas não é
 * gasto nem receita.
 */
function agregar(db: Db, inicio: string, fim: string): Agregado {
  const despesas = soma(
    db,
    "SELECT SUM(valor_centavos) FROM lancamentos WHERE tipo='despesa' AND data BETWEEN ? AND ?",
    [inicio, fim],
  );
  const receitas = soma(
    db,
    "SELECT SUM(valor_centavos) FROM lancamentos WHERE tipo='receita' AND data BETWEEN ? AND ?",
    [inicio, fim],
  );
  const quantidade = soma(
    db,
    "SELECT COUNT(*) FROM lancamentos WHERE data BETWEEN ? AND ?",
    [inicio, fim],
  );

  // Agrupa na categoria raiz: relatório com 40 subcategorias não é legível no
  // Telegram, e "Alimentação" é a unidade de decisão real.
  const linhasCat = db
    .prepare(
      "SELECT COALESCE(cp.nome, c.nome, 'Sem categoria') AS categoria," +
        "       COALESCE(cp.emoji, c.emoji)               AS emoji," +
        "       SUM(l.valor_centavos)                     AS total," +
        "       COUNT(*)                                  AS n " +
        "FROM lancamentos l " +
        "LEFT JOIN categorias c  ON c.id = l.categoria_id " +
        "LEFT JOIN categorias cp ON cp.id = c.parent_id " +
        "WHERE l.tipo = 'despesa' AND l.data BETWEEN ? AND ? " +
        "GROUP BY categoria ORDER BY total DESC",
    )
    .all(inicio, fim) as {
    categoria: string;
    emoji: string | null;
    total: number;
    n: number;
  }[];

  const porCategoria = linhasCat.map((r) => ({
    categoria: r.categoria,
    emoji: r.emoji,
    total_centavos: r.total,
    total_fmt: fmtBrl(r.total),
    quantidade: r.n,
    percentual: despesas ? Math.round((r.total * 1000) / despesas) / 10 : 0,
  }));

  const linhasConta = db
    .prepare(
      "SELECT COALESCE(ct.nome,'Sem conta') AS conta, SUM(l.valor_centavos) AS total, COUNT(*) AS n " +
        "FROM lancamentos l LEFT JOIN contas ct ON ct.id = l.conta_id " +
        "WHERE l.tipo='despesa' AND l.data BETWEEN ? AND ? GROUP BY conta ORDER BY total DESC",
    )
    .all(inicio, fim) as { conta: string; total: number; n: number }[];

  const maiores = (
    db
      .prepare(
        "SELECT * FROM v_lancamentos WHERE tipo='despesa' AND data BETWEEN ? AND ? " +
          "ORDER BY valor_centavos DESC LIMIT 10",
      )
      .all(inicio, fim) as LancamentoView[]
  ).map((r) => dictLancamento(db, r));

  const dias =
    Math.round(
      (Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86400000,
    ) + 1;

  return {
    despesas_centavos: despesas,
    despesas_fmt: fmtBrl(despesas),
    receitas_centavos: receitas,
    receitas_fmt: fmtBrl(receitas),
    resultado_centavos: receitas - despesas,
    resultado_fmt: fmtBrl(receitas - despesas),
    media_diaria_fmt: dias ? fmtBrl(Math.trunc(despesas / dias)) : fmtBrl(0),
    dias,
    quantidade,
    por_categoria: porCategoria,
    por_conta: linhasConta.map((r) => ({
      conta: r.conta,
      total_centavos: r.total,
      total_fmt: fmtBrl(r.total),
      quantidade: r.n,
    })),
    maiores_gastos: maiores,
  };
}

/**
 * Janela imediatamente anterior, de mesmo tamanho.
 *
 * Para um mês civil completo devolve o mês civil anterior — e não "31 dias
 * atrás" —, que é a comparação que faz sentido num relatório mensal.
 */
function periodoAnterior(inicio: string, fim: string): { inicio: string; fim: string } {
  const [aIni, mIni, dIni] = inicio.split("-").map(Number);
  const [aFim, mFim, dFim] = fim.split("-").map(Number);

  if (dIni === 1 && dFim === ultimoDiaDoMes(aFim, mFim)) {
    const fimAnterior = somarDias(inicio, -1);
    const [a, m] = fimAnterior.split("-").map(Number);
    return { inicio: `${a}-${String(m).padStart(2, "0")}-01`, fim: fimAnterior };
  }

  const dias =
    Math.round(
      (Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86400000,
    ) + 1;
  const novoFim = somarDias(inicio, -1);
  return { inicio: somarDias(novoFim, -(dias - 1)), fim: novoFim };
}

export function cmdResumo(db: Db, a: Args): Saida {
  const p = intervaloPeriodo(str(a, "periodo") ?? "mes");
  const dados: Saida = { ...agregar(db, p.inicio, p.fim), periodo: p };

  if (!flag(a, "sem-comparacao")) {
    const ant = periodoAnterior(p.inicio, p.fim);
    const anterior = agregar(db, ant.inicio, ant.fim);
    const atual = dados.despesas_centavos as number;
    dados.comparacao = {
      periodo_anterior: ant,
      despesas_anterior_fmt: fmtBrl(anterior.despesas_centavos),
      variacao_pct: anterior.despesas_centavos
        ? Math.round(
            ((atual - anterior.despesas_centavos) * 1000) / anterior.despesas_centavos,
          ) / 10
        : null,
      diferenca_fmt: fmtBrl(atual - anterior.despesas_centavos),
    };
  }

  return dados;
}

/**
 * Relatório em texto, pronto para enviar no Telegram.
 *
 * Sem tabela markdown, que o Telegram não renderiza. Sem alinhamento por
 * espaços, porque a fonte é proporcional e a coluna sairia torta. Uma
 * informação por linha, com emoji como âncora visual.
 */
export function cmdRelatorio(db: Db, a: Args): Saida {
  const p = intervaloPeriodo(str(a, "periodo") ?? "mes");
  const r = agregar(db, p.inicio, p.fim);
  const ant = periodoAnterior(p.inicio, p.fim);
  const anterior = agregar(db, ant.inicio, ant.fim);
  const top = num(a, "top") ?? 8;

  const L: string[] = [];
  // Travessão em vez de "Resumo de %s": os rótulos não concordam todos com a
  // mesma preposição ("de ontem" funciona, "de este mês" não).
  L.push(`📊 *${str(a, "titulo") ?? `Resumo — ${p.rotulo}`}*`);
  L.push(`_${br(p.inicio)} a ${br(p.fim)}_`);
  L.push("");
  L.push(`💸 Gastos: *${r.despesas_fmt}*`);
  L.push(`💰 Entradas: *${r.receitas_fmt}*`);

  const resultado = r.receitas_centavos - r.despesas_centavos;
  L.push(`${resultado >= 0 ? "🟢" : "🔴"} Resultado: *${fmtBrl(resultado)}*`);

  if (anterior.despesas_centavos) {
    const delta = r.despesas_centavos - anterior.despesas_centavos;
    const pct = (Math.abs(delta) * 100) / anterior.despesas_centavos;
    if (pct < 1) {
      L.push("➡️ Praticamente igual ao período anterior.");
    } else if (delta > 0) {
      L.push(`📈 ${Math.round(pct)}% acima do período anterior (${fmtBrl(delta)})`);
    } else {
      L.push(`📉 ${Math.round(pct)}% abaixo do período anterior (${fmtBrl(-delta)})`);
    }
  }

  if (r.por_categoria.length) {
    L.push("");
    L.push("*Onde o dinheiro foi:*");
    for (const c of r.por_categoria.slice(0, top)) {
      L.push(
        `${c.emoji ?? "•"} ${c.categoria} — ${c.total_fmt} (${Math.round(c.percentual)}%)`,
      );
    }
    const restantes = r.por_categoria.length - top;
    if (restantes > 0) L.push(`_... e ${restantes} categoria(s) menor(es)_`);
  }

  if (r.maiores_gastos.length) {
    L.push("");
    L.push("*Maiores gastos:*");
    for (const g of r.maiores_gastos.slice(0, 5)) {
      L.push(`• ${g.descricao} — ${g.valor_fmt} (${br(g.data)})`);
    }
  }

  const orcamentos = statusOrcamentos(db, mesDe(p.fim));
  const estourados = orcamentos.filter((o) => o.percentual >= 100);
  const proximos = orcamentos.filter(
    (o) => o.percentual < 100 && o.percentual >= o.alerta_pct,
  );
  if (estourados.length || proximos.length) {
    L.push("");
    L.push("*Orçamentos:*");
    for (const o of estourados) {
      L.push(
        `🔴 ${o.categoria} estourou: ${o.gasto_fmt} de ${o.limite_fmt} (${Math.round(o.percentual)}%)`,
      );
    }
    for (const o of proximos) {
      L.push(
        `🟡 ${o.categoria} em ${Math.round(o.percentual)}%: ${o.gasto_fmt} de ${o.limite_fmt}`,
      );
    }
  }

  const texto =
    r.quantidade === 0
      ? [...L.slice(0, 3), "Nenhum lançamento registrado neste período."].join("\n")
      : L.join("\n");

  return {
    periodo: p,
    texto,
    dados: flag(a, "com-dados") ? r : null,
  };
}

interface StatusOrcamento {
  categoria_id: number | null;
  categoria: string;
  mes: string;
  especifico_do_mes: boolean;
  limite_centavos: number;
  limite_fmt: string;
  gasto_centavos: number;
  gasto_fmt: string;
  restante_centavos: number;
  restante_fmt: string;
  percentual: number;
  alerta_pct: number;
  situacao: SituacaoOrcamento;
}

/**
 * Situação de cada orçamento no mês.
 *
 * Orçamento específico do mês tem precedência sobre o recorrente (mes NULL)
 * para a mesma categoria.
 */
function statusOrcamentos(db: Db, mes: string): StatusOrcamento[] {
  const linhas = db
    .prepare(
      "SELECT * FROM orcamentos WHERE mes IS NULL OR mes = ? ORDER BY (mes IS NULL)",
    )
    .all(mes) as {
    categoria_id: number | null;
    mes: string | null;
    limite_centavos: number;
    alerta_pct: number;
  }[];

  const vistos = new Set<number | null>();
  const status: StatusOrcamento[] = [];

  for (const o of linhas) {
    if (vistos.has(o.categoria_id)) continue;
    vistos.add(o.categoria_id);

    let gasto: number;
    let nome: string;
    if (o.categoria_id) {
      const ids = idsCategoriaEFilhas(db, o.categoria_id);
      gasto = soma(
        db,
        "SELECT SUM(valor_centavos) FROM lancamentos WHERE tipo='despesa' " +
          `AND substr(data,1,7) = ? AND categoria_id IN (${ids.map(() => "?").join(",")})`,
        [mes, ...ids],
      );
      nome = nomeCategoriaCompleto(db, o.categoria_id);
    } else {
      gasto = soma(
        db,
        "SELECT SUM(valor_centavos) FROM lancamentos WHERE tipo='despesa' AND substr(data,1,7) = ?",
        [mes],
      );
      nome = "Total do mês";
    }

    const limite = o.limite_centavos;
    const pct = limite ? Math.round((gasto * 1000) / limite) / 10 : 0;

    status.push({
      categoria_id: o.categoria_id,
      categoria: nome,
      mes,
      especifico_do_mes: o.mes !== null,
      limite_centavos: limite,
      limite_fmt: fmtBrl(limite),
      gasto_centavos: gasto,
      gasto_fmt: fmtBrl(gasto),
      restante_centavos: limite - gasto,
      restante_fmt: fmtBrl(limite - gasto),
      percentual: pct,
      alerta_pct: o.alerta_pct,
      situacao: pct >= 100 ? "estourado" : pct >= o.alerta_pct ? "atencao" : "ok",
    });
  }

  status.sort((a, b) => b.percentual - a.percentual);
  return status;
}

/**
 * Orçamento que cobre esta categoria (ela mesma, a pai, ou o teto global) — o
 * que o agente precisa saber logo após registrar o gasto.
 */
function statusOrcamentoDaCategoria(
  db: Db,
  categoriaId: number,
  mes: string,
): StatusOrcamento | null {
  const row = db.prepare("SELECT parent_id FROM categorias WHERE id = ?").get(
    categoriaId,
  ) as { parent_id: number | null } | undefined;

  const candidatos = [categoriaId];
  if (row?.parent_id) candidatos.push(row.parent_id);

  const todos = statusOrcamentos(db, mes);
  for (const cand of candidatos) {
    const achado = todos.find((s) => s.categoria_id === cand);
    if (achado) return achado;
  }
  return todos.find((s) => s.categoria_id === null) ?? null;
}

export function cmdOrcamento(db: Db, a: Args, posicionais: string[]): Saida {
  const acao = posicionais[0] ?? "status";
  const mesArg = str(a, "mes");

  if (acao === "set") {
    const limite = parseValor(str(a, "limite"));
    const categoriaId = str(a, "categoria")
      ? resolverCategoria(db, str(a, "categoria"))
      : null;
    if (mesArg && !mesValido(mesArg)) {
      throw new FinErro(`Mês inválido: ${mesArg}. Use YYYY-MM.`);
    }
    const alerta = num(a, "alerta") ?? 80;

    // Delete-then-insert em vez de ON CONFLICT: no SQLite um UNIQUE com coluna
    // NULL não conflita (NULLs são distintos), então ON CONFLICT nunca
    // dispararia para o teto global (categoria_id NULL) nem para orçamento sem
    // mês, e cada `set` criaria uma duplicata. `IS` compara NULL corretamente.
    transacao(db, () => {
      db.prepare("DELETE FROM orcamentos WHERE categoria_id IS ? AND mes IS ?").run(
        categoriaId,
        mesArg ?? null,
      );
      db.prepare(
        "INSERT INTO orcamentos (categoria_id, mes, limite_centavos, alerta_pct, criado_em) " +
          "VALUES (?,?,?,?,?)",
      ).run(categoriaId, mesArg ?? null, limite, alerta, agora());
    });

    return {
      acao: "definido",
      alvo: categoriaId ? nomeCategoriaCompleto(db, categoriaId) : "Total do mês",
      limite_fmt: fmtBrl(limite),
      alerta_pct: alerta,
      status: statusOrcamentos(db, mesArg ?? mesDe(hoje())),
    };
  }

  if (acao === "rm") {
    const categoriaId = str(a, "categoria")
      ? resolverCategoria(db, str(a, "categoria"))
      : null;
    const info = db
      .prepare("DELETE FROM orcamentos WHERE categoria_id IS ? AND mes IS ?")
      .run(categoriaId, mesArg ?? null);
    if (!Number(info.changes)) {
      throw new FinErro("Não havia orçamento definido para esse alvo.");
    }
    return { acao: "removido", quantidade: Number(info.changes) };
  }

  const mes = mesArg ?? mesDe(hoje());
  const status = statusOrcamentos(db, mes);
  return {
    mes,
    quantidade: status.length,
    orcamentos: status,
    estourados: status.filter((o) => o.percentual >= 100),
  };
}

/**
 * Verifica limites e devolve só o que merece notificação.
 *
 * Feito para o cron: sem novidade, `silent` vem true e o agente responde
 * `[SILENT]`, que o Hermes trata como "não entregar mensagem". Sem isso, o bot
 * mandaria "está tudo bem" várias vezes por dia.
 */
export function cmdAlertas(db: Db, a: Args): Saida {
  const mes = str(a, "mes") ?? mesDe(hoje());
  const status = statusOrcamentos(db, mes);
  const marcar = flag(a, "marcar");
  const repetir = flag(a, "repetir");

  const alertas: Saida[] = [];
  for (const s of status) {
    if (s.situacao === "ok") continue;
    const nivel = s.situacao;
    const chave = `orcamento:${s.categoria_id ?? "global"}`;

    if (!repetir) {
      const ja = db
        .prepare(
          "SELECT 1 FROM alertas_enviados WHERE chave=? AND mes=? AND nivel=?",
        )
        .get(chave, mes, nivel);
      if (ja) continue;
    }

    const pct = Math.round(s.percentual);
    alertas.push({
      chave,
      nivel,
      categoria: s.categoria,
      limite_fmt: s.limite_fmt,
      gasto_fmt: s.gasto_fmt,
      restante_fmt: s.restante_fmt,
      percentual: s.percentual,
      mensagem:
        nivel === "estourado"
          ? `🔴 ${s.categoria} estourou o limite do mês: ${s.gasto_fmt} de ${s.limite_fmt} (${pct}%).`
          : `🟡 ${s.categoria} já está em ${pct}% do limite: ${s.gasto_fmt} de ${s.limite_fmt}. Restam ${s.restante_fmt}.`,
    });
  }

  if (marcar && alertas.length) {
    const ts = agora();
    transacao(db, () => {
      const ins = db.prepare(
        "INSERT OR REPLACE INTO alertas_enviados (chave, mes, nivel, enviado_em) VALUES (?,?,?,?)",
      );
      for (const al of alertas) ins.run(al.chave as string, mes, al.nivel as string, ts);
    });
  }

  return {
    mes,
    silent: alertas.length === 0,
    quantidade: alertas.length,
    alertas,
  };
}

export function cmdConta(db: Db, a: Args, posicionais: string[]): Saida {
  const acao = posicionais[0] ?? "list";
  const nome = str(a, "nome");

  if (acao === "add") {
    if (!nome) throw new FinErro("Informe --nome.");
    const tipo = (str(a, "tipo") ?? "conta") as TipoConta;
    if (!TIPOS_CONTA.includes(tipo)) {
      throw new FinErro(`Tipo de conta inválido. Use um de: ${TIPOS_CONTA.join(", ")}.`);
    }
    try {
      const info = db
        .prepare(
          "INSERT INTO contas (nome, tipo, instituicao, dia_fechamento, dia_vencimento," +
            " limite_centavos, saldo_inicial_centavos, criada_em) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          nome.trim(),
          tipo,
          str(a, "instituicao") ?? null,
          num(a, "fechamento") ?? null,
          num(a, "vencimento") ?? null,
          str(a, "limite") ? parseValor(str(a, "limite")) : null,
          str(a, "saldo-inicial") ? parseValor(str(a, "saldo-inicial")) : 0,
          agora(),
        );
      return { acao: "criada", id: Number(info.lastInsertRowid), nome: nome.trim() };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinErro(`Já existe uma conta chamada ${JSON.stringify(nome)}.`);
      }
      throw e;
    }
  }

  if (acao === "rm") {
    const contaId = resolverConta(db, nome, false)!;
    const usos = soma(
      db,
      "SELECT COUNT(*) FROM lancamentos WHERE conta_id = ? OR conta_destino_id = ?",
      [contaId, contaId],
    );
    // Desativa em vez de apagar: remover a conta levaria o histórico ligado a ela.
    db.prepare("UPDATE contas SET ativa = 0 WHERE id = ?").run(contaId);
    return { acao: "desativada", id: contaId, lancamentos_preservados: usos };
  }

  if (acao === "padrao") {
    const contaId = resolverConta(db, nome, false)!;
    const row = db.prepare("SELECT nome FROM contas WHERE id = ?").get(contaId) as {
      nome: string;
    };
    setConfig(db, "conta_padrao", row.nome);
    return { acao: "conta_padrao_definida", nome: row.nome };
  }

  return cmdSaldo(db);
}

export function cmdCategoria(db: Db, a: Args, posicionais: string[]): Saida {
  const acao = posicionais[0] ?? "list";
  const nome = str(a, "nome");

  if (acao === "add") {
    if (!nome) throw new FinErro("Informe --nome.");
    const parentId = str(a, "pai") ? resolverCategoria(db, str(a, "pai")) : null;
    try {
      const info = db
        .prepare("INSERT INTO categorias (nome, parent_id, tipo, emoji) VALUES (?,?,?,?)")
        .run(nome.trim(), parentId, str(a, "tipo") ?? "despesa", str(a, "emoji") ?? null);
      const id = Number(info.lastInsertRowid);
      return { acao: "criada", id, nome: nomeCategoriaCompleto(db, id) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinErro("Essa categoria já existe nesse nível.");
      }
      throw e;
    }
  }

  if (acao === "rm") {
    const categoriaId = resolverCategoria(db, nome)!;
    db.prepare("UPDATE categorias SET ativa = 0 WHERE id = ?").run(categoriaId);
    return { acao: "desativada", id: categoriaId };
  }

  const linhas = db
    .prepare(
      "SELECT c.id, c.nome, c.tipo, c.emoji, c.parent_id, p.nome AS pai " +
        "FROM categorias c LEFT JOIN categorias p ON p.id = c.parent_id " +
        "WHERE c.ativa = 1 " +
        "ORDER BY COALESCE(p.nome, c.nome), (c.parent_id IS NOT NULL), c.nome",
    )
    .all() as {
    id: number;
    nome: string;
    tipo: string;
    emoji: string | null;
    parent_id: number | null;
    pai: string | null;
  }[];

  const arvore: Record<
    string,
    { id: number | null; emoji: string | null; tipo: string | null; subcategorias: string[] }
  > = {};

  for (const r of linhas) {
    if (r.parent_id === null) {
      arvore[r.nome] ??= { id: r.id, emoji: r.emoji, tipo: r.tipo, subcategorias: [] };
      arvore[r.nome].id = r.id;
      arvore[r.nome].emoji = r.emoji;
      arvore[r.nome].tipo = r.tipo;
    } else {
      const pai = r.pai!;
      arvore[pai] ??= { id: null, emoji: null, tipo: null, subcategorias: [] };
      arvore[pai].subcategorias.push(r.nome);
    }
  }

  return { quantidade: linhas.length, categorias: arvore };
}

function avancar(iso: string, frequencia: string, _dia: number): string {
  if (frequencia === "semanal") return somarDias(iso, 7);
  if (frequencia === "anual") return somarMeses(iso, 12);
  return somarMeses(iso, 1);
}

/** Primeira data futura (ou hoje) da recorrência. */
function proximaOcorrencia(frequencia: string, dia: number): string {
  const ref = hoje();
  const [ano, mes, diaHoje] = ref.split("-").map(Number);

  if (frequencia === "semanal") {
    // `dia` = 0..6 (segunda..domingo)
    const semanaHoje = (new Date(`${ref}T00:00:00Z`).getUTCDay() + 6) % 7;
    return somarDias(ref, (dia - semanaHoje + 7) % 7);
  }
  if (frequencia === "anual") return ref;

  const alvo = Math.min(Math.max(1, dia), ultimoDiaDoMes(ano, mes));
  const nesteMes = `${ano}-${String(mes).padStart(2, "0")}-${String(alvo).padStart(2, "0")}`;
  return alvo >= diaHoje ? nesteMes : somarMeses(nesteMes, 1);
}

export function cmdRecorrente(db: Db, a: Args, posicionais: string[]): Saida {
  const acao = posicionais[0] ?? "list";

  if (acao === "add") {
    const descricao = str(a, "descricao");
    if (!descricao) throw new FinErro("Informe --descricao.");
    const valor = parseValor(str(a, "valor"));
    const frequencia = str(a, "frequencia") ?? "mensal";
    const dia = num(a, "dia") ?? 1;
    const proxima = proximaOcorrencia(frequencia, dia);

    const info = db
      .prepare(
        "INSERT INTO recorrentes (descricao, tipo, valor_centavos, categoria_id, conta_id," +
          " frequencia, dia, proxima_data, fim, criada_em) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        descricao.trim(),
        str(a, "tipo") ?? "despesa",
        valor,
        resolverCategoria(db, str(a, "categoria"), true),
        resolverConta(db, str(a, "conta")),
        frequencia,
        dia,
        proxima,
        str(a, "fim") ? parseData(str(a, "fim")) : null,
        agora(),
      );

    return {
      acao: "criada",
      id: Number(info.lastInsertRowid),
      descricao: descricao.trim(),
      valor_fmt: fmtBrl(valor),
      proxima_data: proxima,
    };
  }

  if (acao === "rm") {
    const id = num(a, "id");
    if (id === undefined) throw new FinErro("Informe --id.");
    const info = db.prepare("UPDATE recorrentes SET ativa = 0 WHERE id = ?").run(id);
    if (!Number(info.changes)) throw new FinErro(`Não achei a recorrência #${id}.`);
    return { acao: "desativada", id };
  }

  if (acao === "aplicar") {
    // Idempotente por (recorrente, data): rodar duas vezes no mesmo dia não
    // duplica o aluguel.
    const hojeIso = hoje();
    const pendentes = db
      .prepare(
        "SELECT * FROM recorrentes WHERE ativa = 1 AND proxima_data <= ? " +
          "AND (fim IS NULL OR proxima_data <= fim)",
      )
      .all(hojeIso) as {
      id: number;
      tipo: string;
      valor_centavos: number;
      descricao: string;
      categoria_id: number | null;
      conta_id: number | null;
      frequencia: string;
      dia: number;
      proxima_data: string;
      fim: string | null;
    }[];

    const gerados: Saida[] = [];
    const ts = agora();

    for (const r of pendentes) {
      let data = r.proxima_data;
      // Avança até hoje, cobrindo o caso de o bot ter ficado dias fora.
      while (data <= hojeIso) {
        if (r.fim && data > r.fim) break;
        const existe = db
          .prepare("SELECT 1 FROM lancamentos WHERE recorrente_id = ? AND data = ?")
          .get(r.id, data);
        if (!existe) {
          const info = db
            .prepare(
              "INSERT INTO lancamentos (tipo, valor_centavos, descricao, data, categoria_id," +
                " conta_id, origem, recorrente_id, criado_em, atualizado_em)" +
                " VALUES (?,?,?,?,?,?,'recorrente',?,?,?)",
            )
            .run(
              r.tipo,
              r.valor_centavos,
              r.descricao,
              data,
              r.categoria_id,
              r.conta_id,
              r.id,
              ts,
              ts,
            );
          gerados.push({
            id: Number(info.lastInsertRowid),
            descricao: r.descricao,
            data,
            valor_fmt: fmtBrl(r.valor_centavos),
          });
        }
        data = avancar(data, r.frequencia, r.dia);
      }
      db.prepare("UPDATE recorrentes SET proxima_data = ? WHERE id = ?").run(data, r.id);
    }

    return {
      acao: "aplicadas",
      quantidade: gerados.length,
      gerados,
      silent: gerados.length === 0,
    };
  }

  const linhas = db
    .prepare(
      "SELECT r.*, c.nome AS categoria, ct.nome AS conta FROM recorrentes r " +
        "LEFT JOIN categorias c ON c.id = r.categoria_id " +
        "LEFT JOIN contas ct ON ct.id = r.conta_id " +
        "WHERE r.ativa = 1 ORDER BY r.proxima_data",
    )
    .all() as Record<string, unknown>[];

  let totalMensal = 0;
  const itens = linhas.map((r) => {
    if (r.frequencia === "mensal" && r.tipo === "despesa") {
      totalMensal += Number(r.valor_centavos);
    }
    return { ...r, valor_fmt: fmtBrl(Number(r.valor_centavos)) };
  });

  return {
    quantidade: itens.length,
    total_mensal_fixo_fmt: fmtBrl(totalMensal),
    recorrentes: itens,
  };
}

function listarMetas(db: Db): Saida[] {
  const linhas = db
    .prepare("SELECT * FROM metas WHERE ativa = 1 ORDER BY prazo IS NULL, prazo")
    .all() as {
    id: number;
    nome: string;
    valor_alvo_centavos: number;
    valor_atual_centavos: number;
    prazo: string | null;
  }[];

  return linhas.map((m) => {
    const pct = Math.round((m.valor_atual_centavos * 1000) / m.valor_alvo_centavos) / 10;
    const falta = m.valor_alvo_centavos - m.valor_atual_centavos;
    const item: Saida = {
      id: m.id,
      nome: m.nome,
      alvo_fmt: fmtBrl(m.valor_alvo_centavos),
      atual_fmt: fmtBrl(m.valor_atual_centavos),
      falta_fmt: fmtBrl(falta),
      percentual: pct,
      prazo: m.prazo,
      concluida: pct >= 100,
    };
    if (m.prazo) {
      const dias = Math.round(
        (Date.parse(`${m.prazo}T00:00:00Z`) - Date.parse(`${hoje()}T00:00:00Z`)) / 86400000,
      );
      item.dias_restantes = dias;
      if (dias > 0 && pct < 100) {
        item.aporte_mensal_necessario_fmt = fmtBrl(
          Math.trunc(falta / Math.max(1, dias / 30)),
        );
      }
    }
    return item;
  });
}

export function cmdMeta(db: Db, a: Args, posicionais: string[]): Saida {
  const acao = posicionais[0] ?? "list";
  const nome = str(a, "nome");

  if (acao === "add") {
    if (!nome) throw new FinErro("Informe --nome.");
    const alvo = parseValor(str(a, "alvo"));
    try {
      const info = db
        .prepare(
          "INSERT INTO metas (nome, valor_alvo_centavos, valor_atual_centavos, prazo, criada_em)" +
            " VALUES (?,?,?,?,?)",
        )
        .run(
          nome.trim(),
          alvo,
          str(a, "inicial") ? parseValor(str(a, "inicial")) : 0,
          str(a, "prazo") ? parseData(str(a, "prazo")) : null,
          agora(),
        );
      return { acao: "criada", id: Number(info.lastInsertRowid), alvo_fmt: fmtBrl(alvo) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinErro("Já existe uma meta com esse nome.");
      }
      throw e;
    }
  }

  if (acao === "aportar") {
    const valor = parseValor(str(a, "valor"));
    const row = db
      .prepare("SELECT * FROM metas WHERE nome = ? COLLATE NOCASE AND ativa = 1")
      .get(nome ?? "") as { id: number; nome: string } | undefined;
    if (!row) throw new FinErro(`Não achei a meta ${JSON.stringify(nome)}.`);
    db.prepare(
      "UPDATE metas SET valor_atual_centavos = valor_atual_centavos + ? WHERE id = ?",
    ).run(valor, row.id);
    return {
      acao: "aporte_registrado",
      meta: row.nome,
      aporte_fmt: fmtBrl(valor),
      metas: listarMetas(db),
    };
  }

  if (acao === "rm") {
    const info = db
      .prepare("UPDATE metas SET ativa = 0 WHERE nome = ? COLLATE NOCASE")
      .run(nome ?? "");
    if (!Number(info.changes)) {
      throw new FinErro(`Não achei a meta ${JSON.stringify(nome)}.`);
    }
    return { acao: "removida", nome };
  }

  return { metas: listarMetas(db) };
}

function csvCampo(valor: unknown): string {
  const s = String(valor ?? "");
  return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Exporta os lançamentos do período.
 *
 * CSV sai com `;` e vírgula decimal, em UTF-8 com BOM: é o que faz o Excel em
 * português abrir com as colunas certas e os números reconhecidos como número,
 * sem passo de importação.
 */
export function cmdExport(db: Db, a: Args, caminhoDb: string): Saida {
  const p = intervaloPeriodo(str(a, "periodo") ?? "mes");
  const formato = str(a, "formato") ?? "csv";
  if (!["csv", "json", "md"].includes(formato)) {
    throw new FinErro(`Formato inválido: ${formato}. Use csv, json ou md.`);
  }

  const itens = (
    db
      .prepare("SELECT * FROM v_lancamentos WHERE data BETWEEN ? AND ? ORDER BY data, id")
      .all(p.inicio, p.fim) as LancamentoView[]
  ).map((r) => dictLancamento(db, r));

  const destinoDir = str(a, "destino") ?? join(dirname(resolve(caminhoDb)), "exports");
  mkdirSync(destinoDir, { recursive: true });
  const base = `financas-${p.inicio}-a-${p.fim}`;

  let caminho: string;
  if (formato === "json") {
    caminho = join(destinoDir, `${base}.json`);
    writeFileSync(caminho, JSON.stringify(itens, null, 2), "utf8");
  } else if (formato === "md") {
    caminho = join(destinoDir, `${base}.md`);
    const L = [
      `# Lançamentos — ${brCompleto(p.inicio)} a ${brCompleto(p.fim)}`,
      "",
      "| Data | Tipo | Descrição | Categoria | Conta | Valor |",
      "|---|---|---|---|---|---|",
      ...itens.map(
        (i) =>
          `| ${brCompleto(i.data)} | ${i.tipo} | ${i.descricao.replaceAll("|", "/")} ` +
          `| ${i.categoria_completa} | ${i.conta} | ${i.valor_fmt} |`,
      ),
    ];
    writeFileSync(caminho, `${L.join("\n")}\n`, "utf8");
  } else {
    caminho = join(destinoDir, `${base}.csv`);
    const linhas = [
      [
        "id", "data", "tipo", "descricao", "categoria", "subcategoria",
        "conta", "valor", "parcela", "tags", "observacao",
      ].join(";"),
      ...itens.map((i) =>
        [
          i.id,
          brCompleto(i.data),
          i.tipo,
          i.descricao,
          i.categoria_pai ?? i.categoria,
          i.categoria_pai ? i.categoria : "",
          i.conta,
          (i.valor_centavos / 100).toFixed(2).replace(".", ","),
          i.parcela ?? "",
          i.tags.join(", "),
          i.observacao ?? "",
        ]
          .map(csvCampo)
          .join(";"),
      ),
    ];
    // BOM + CRLF: o que o Excel espera.
    writeFileSync(caminho, `﻿${linhas.join("\r\n")}\r\n`, "utf8");
  }

  return { arquivo: caminho, formato, periodo: p, quantidade: itens.length };
}

type OpcaoTipo = "string" | "boolean";

const OPCOES_COMUNS: Record<string, OpcaoTipo> = {
  valor: "string",
  descricao: "string",
  categoria: "string",
  conta: "string",
  data: "string",
  tipo: "string",
  tags: "string",
  obs: "string",
};

const SPECS: Record<string, Record<string, OpcaoTipo>> = {
  init: {},
  add: {
    ...OPCOES_COMUNS,
    "conta-destino": "string",
    parcelas: "string",
    origem: "string",
  },
  edit: OPCOES_COMUNS,
  rm: { grupo: "boolean" },
  ls: {
    periodo: "string",
    categoria: "string",
    conta: "string",
    tipo: "string",
    tag: "string",
    texto: "string",
    limite: "string",
    ordem: "string",
  },
  busca: { limite: "string" },
  saldo: {},
  resumo: { periodo: "string", "sem-comparacao": "boolean" },
  relatorio: {
    periodo: "string",
    titulo: "string",
    top: "string",
    "com-dados": "boolean",
  },
  orcamento: {
    categoria: "string",
    limite: "string",
    mes: "string",
    alerta: "string",
  },
  alertas: { mes: "string", marcar: "boolean", repetir: "boolean" },
  conta: {
    nome: "string",
    tipo: "string",
    instituicao: "string",
    fechamento: "string",
    vencimento: "string",
    limite: "string",
    "saldo-inicial": "string",
  },
  categoria: { nome: "string", pai: "string", tipo: "string", emoji: "string" },
  recorrente: {
    id: "string",
    descricao: "string",
    valor: "string",
    categoria: "string",
    conta: "string",
    tipo: "string",
    frequencia: "string",
    dia: "string",
    fim: "string",
  },
  meta: {
    nome: "string",
    alvo: "string",
    valor: "string",
    inicial: "string",
    prazo: "string",
  },
  export: { periodo: "string", formato: "string", destino: "string" },
};

const USO = `Controle financeiro pessoal. Toda saída é JSON.

  node fin.ts [--db CAMINHO] <subcomando> [opções]

Subcomandos: ${Object.keys(SPECS).join(", ")}

Exemplos:
  node fin.ts add --valor 27 --descricao "Uber" --categoria "Uber/99"
  node fin.ts resumo --periodo mes
  node fin.ts relatorio --periodo mes-passado
  node fin.ts orcamento set --categoria Alimentação --limite 500
`;

export function main(argv: string[]): number {
  // --db é global: extrai antes de escolher o spec do subcomando.
  let caminhoDb: string | undefined;
  const resto: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      caminhoDb = argv[++i];
    } else if (argv[i].startsWith("--db=")) {
      caminhoDb = argv[i].slice(5);
    } else {
      resto.push(argv[i]);
    }
  }

  const comando = resto[0];
  if (!comando || comando === "--help" || comando === "-h" || comando === "help") {
    process.stdout.write(USO);
    return comando ? 0 : 1;
  }

  try {
    if (!(comando in SPECS)) {
      throw new FinErro(
        `Subcomando desconhecido: ${comando}. Use um de: ${Object.keys(SPECS).join(", ")}.`,
      );
    }

    const spec = SPECS[comando];
    let valores: Args;
    let posicionais: string[];
    try {
      const parsed = parseArgs({
        args: resto.slice(1),
        options: Object.fromEntries(
          Object.entries(spec).map(([k, t]) => [k, { type: t }]),
        ) as never,
        allowPositionals: true,
        strict: true,
      });
      valores = parsed.values as Args;
      posicionais = parsed.positionals;
    } catch (e) {
      // Transforma o erro técnico do parseArgs em algo que o agente entende e
      // pode repassar ao usuário.
      throw new FinErro(
        `${(e as Error).message}. Opções aceitas em \`${comando}\`: ` +
          `${Object.keys(spec).map((k) => `--${k}`).join(", ") || "nenhuma"}.`,
      );
    }

    const alvo = caminhoDb ?? process.env.FIN_DB;
    let saida: Saida;

    if (comando === "init") {
      saida = init(alvo) as unknown as Saida;
    } else {
      const db = conectar(alvo);
      try {
        // Auto-migra: qualquer comando funciona num banco novo, sem exigir
        // `init` manual antes.
        if (versaoAtual(db) < SCHEMA_VERSION_ATUAL) {
          migrate(db);
          semear(db);
        }

        switch (comando) {
          case "add": saida = cmdAdd(db, valores); break;
          case "edit": saida = cmdEdit(db, valores, posicionais); break;
          case "rm": saida = cmdRm(db, valores, posicionais); break;
          case "ls": saida = cmdLs(db, valores); break;
          case "busca": saida = cmdBusca(db, valores, posicionais); break;
          case "saldo": saida = cmdSaldo(db); break;
          case "resumo": saida = cmdResumo(db, valores); break;
          case "relatorio": saida = cmdRelatorio(db, valores); break;
          case "orcamento": saida = cmdOrcamento(db, valores, posicionais); break;
          case "alertas": saida = cmdAlertas(db, valores); break;
          case "conta": saida = cmdConta(db, valores, posicionais); break;
          case "categoria": saida = cmdCategoria(db, valores, posicionais); break;
          case "recorrente": saida = cmdRecorrente(db, valores, posicionais); break;
          case "meta": saida = cmdMeta(db, valores, posicionais); break;
          case "export":
            saida = cmdExport(db, valores, alvo ?? "/opt/data/financas/financas.db");
            break;
          default:
            throw new FinErro(`Subcomando não implementado: ${comando}.`);
        }
      } finally {
        db.close();
      }
    }

    process.stdout.write(`${JSON.stringify({ ok: true, ...saida }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const mensagem =
      e instanceof FinErro
        ? e.message
        : `Erro inesperado: ${(e as Error).message ?? String(e)}`;
    process.stdout.write(`${JSON.stringify({ ok: false, erro: mensagem }, null, 2)}\n`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
