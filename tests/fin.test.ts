/**
 * Testes da CLI financeira.
 *
 * Rodam sem credenciais, sem container e sem rede: é o que permite validar o bot
 * antes de ter chave da OpenRouter ou token do Telegram.
 *
 * O foco é onde um erro passaria despercebido e corromperia meses de dados:
 * aritmética de dinheiro, fronteiras de calendário, hierarquia de categorias no
 * orçamento e idempotência das recorrências.
 *
 *     node --test tests/
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FinErro,
  fmtBrl,
  hoje,
  intervaloPeriodo,
  mesDe,
  parseData,
  parseValor,
  somarDias,
  cent,
} from "../skills/financas/scripts/db.ts";

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const FIN = join(RAIZ, "skills", "financas", "scripts", "fin.ts");

interface Resposta {
  ok: boolean;
  erro?: string;
  _exit: number;
  [k: string]: unknown;
}

/**
 * Executa a CLI como o agente executaria — via subprocess.
 *
 * Testar pelo processo, e não importando as funções, é o que garante que o
 * contrato de saída e os códigos de saída realmente funcionam.
 */
function run(banco: string, ...args: string[]): Resposta {
  const proc = spawnSync(process.execPath, [FIN, "--db", banco, ...args], {
    encoding: "utf8",
  });
  assert.ok(proc.stdout, `sem saída. stderr: ${proc.stderr}`);
  return { ...JSON.parse(proc.stdout), _exit: proc.status ?? -1 };
}

function ok(banco: string, ...args: string[]): Resposta {
  const r = run(banco, ...args);
  assert.equal(r.ok, true, `esperava sucesso, veio: ${r.erro}`);
  assert.equal(r._exit, 0);
  return r;
}

function erro(banco: string, ...args: string[]): string {
  const r = run(banco, ...args);
  assert.equal(r.ok, false, "esperava erro, veio sucesso");
  assert.equal(r._exit, 1);
  return r.erro!;
}

/** Banco novo e inicializado. */
function novoBanco(): string {
  const dir = mkdtempSync(join(tmpdir(), "fin-teste-"));
  const caminho = join(dir, "teste.db");
  ok(caminho, "init");
  return caminho;
}

const lanc = (r: Resposta) => r.lancamento as Record<string, never>;
const parcelas = (r: Resposta) => r.parcelas as Record<string, never>[];

describe("valores", () => {
  const casos: [unknown, number][] = [
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
  for (const [entrada, esperado] of casos) {
    test(`parseValor(${JSON.stringify(entrada)}) = ${esperado}`, () => {
      assert.equal(parseValor(entrada), esperado);
    });
  }

  for (const ruim of ["", "abc", null, undefined, 0, "0", "R$", true]) {
    test(`recusa ${JSON.stringify(ruim)}`, () => {
      assert.throws(() => parseValor(ruim), FinErro);
    });
  }

  const formatos: [number, string][] = [
    [0, "R$ 0,00"],
    [5, "R$ 0,05"],
    [2700, "R$ 27,00"],
    [123456, "R$ 1.234,56"],
    [100000000, "R$ 1.000.000,00"],
    [-2700, "-R$ 27,00"],
  ];
  for (const [centavos, texto] of formatos) {
    test(`fmtBrl(${centavos}) = ${texto}`, () => {
      assert.equal(fmtBrl(cent(centavos)), texto);
    });
  }

  test("sem erro de ponto flutuante em cem somas", () => {
    // 0,10 somado cem vezes tem que dar exatamente R$ 10,00. É o motivo de
    // dinheiro ser inteiro: com float daria 9,999999999999998.
    const banco = novoBanco();
    for (let i = 0; i < 100; i++) {
      ok(banco, "add", "--valor", "0,10", "--descricao", `café ${i}`, "--categoria", "Café");
    }
    const r = ok(banco, "resumo", "--periodo", "mes");
    assert.equal(r.despesas_centavos, 1000);
    assert.equal(r.despesas_fmt, "R$ 10,00");
  });
});

describe("datas", () => {
  test("relativas", () => {
    assert.equal(parseData("hoje"), hoje());
    assert.equal(parseData("ontem"), somarDias(hoje(), -1));
    assert.equal(parseData("anteontem"), somarDias(hoje(), -2));
    assert.equal(parseData(null), hoje());
    assert.equal(parseData(""), hoje());
    assert.equal(parseData(undefined), hoje());
  });

  test("formatos explícitos", () => {
    assert.equal(parseData("2026-03-15"), "2026-03-15");
    assert.equal(parseData("15/03/2026"), "2026-03-15");
    assert.equal(parseData("15-03-2026"), "2026-03-15");
    assert.equal(parseData("15/03/26"), "2026-03-15");
  });

  test("DD/MM assume o ano corrente", () => {
    const [ano, mes] = hoje().split("-");
    assert.equal(parseData(`01/${mes}`), `${ano}-${mes}-01`);
  });

  test("DD/MM muito no futuro recua um ano", () => {
    // Uma data que cairia mais de um mês à frente foi, na verdade, do ano
    // passado — o caso de lançar "28/12" já em janeiro.
    const futuro = somarDias(hoje(), 90);
    const [, mes, dia] = futuro.split("-");
    assert.ok(parseData(`${dia}/${mes}`) <= somarDias(hoje(), 31));
  });

  test("dia N do mês corrente", () => {
    const [ano, mes] = hoje().split("-");
    assert.equal(parseData("dia 1"), `${ano}-${mes}-01`);
  });

  test("datas inexistentes são recusadas", () => {
    assert.throws(() => parseData("31/02/2026"), FinErro);
    assert.throws(() => parseData("2026-13-01"), FinErro);
    assert.throws(() => parseData("2026-02-30"), FinErro);
    assert.throws(() => parseData("qualquer coisa"), FinErro);
  });

  const periodos = ["hoje", "ontem", "semana", "semana-passada", "mes", "mes-passado",
    "mes-completo", "ano", "ano-passado", "30d", "7d", "2026-03", "tudo"];
  for (const p of periodos) {
    test(`período ${p}`, () => {
      const r = intervaloPeriodo(p);
      assert.ok(r.inicio <= r.fim, `${r.inicio} > ${r.fim}`);
      assert.ok(r.rotulo);
    });
  }

  test("período inválido", () => {
    assert.throws(() => intervaloPeriodo("quinzena lunar"), FinErro);
  });

  test("mês civil tem o último dia certo", () => {
    const fev = intervaloPeriodo("2026-02");
    assert.equal(fev.inicio, "2026-02-01");
    assert.equal(fev.fim, "2026-02-28");
  });

  test("ano bissexto", () => {
    assert.equal(intervaloPeriodo("2028-02").fim, "2028-02-29");
  });

  test("semana começa na segunda", () => {
    const r = intervaloPeriodo("semana", "2026-08-05"); // quarta
    assert.equal(r.inicio, "2026-08-03"); // segunda
  });

  test("mesDe", () => {
    assert.equal(mesDe("2026-08-03"), "2026-08");
  });
});

describe("lançamentos", () => {
  test("add mínimo usa os defaults", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "27", "--descricao", "Uber");
    const l = lanc(r);
    assert.equal(l.tipo, "despesa");
    assert.equal(l.data, hoje());
    assert.equal(l.conta, "Carteira");
    assert.equal(r.id, l.id);
  });

  test("descrição é obrigatória", () => {
    const banco = novoBanco();
    assert.match(erro(banco, "add", "--valor", "10", "--descricao", "  "), /Descrição/);
  });

  test("categoria inexistente é criada em vez de falhar", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "50", "--descricao", "Curso",
      "--categoria", "Cerâmica artesanal");
    assert.match(String(lanc(r).categoria_completa), /Cerâmica artesanal/);
  });

  test("categoria casa sem acento e sem caixa", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "20", "--descricao", "Almoço",
      "--categoria", "ALIMENTACAO");
    assert.equal(lanc(r).categoria, "Alimentação");
  });

  test("subcategoria tem precedência sobre a raiz", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "35", "--descricao", "iFood",
      "--categoria", "Delivery");
    assert.equal(lanc(r).categoria, "Delivery");
    assert.equal(lanc(r).categoria_pai, "Alimentação");
  });

  test("conta inexistente falha com mensagem clara", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "add", "--valor", "10", "--descricao", "x", "--conta", "Banco Fantasma"),
      /não existe/,
    );
  });

  test("tags", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "80", "--descricao", "Jantar",
      "--categoria", "Restaurante", "--tags", "trabalho, reembolsável");
    assert.deepEqual(lanc(r).tags, ["reembolsável", "trabalho"]);
  });

  test("edit altera só o informado", () => {
    const banco = novoBanco();
    const criado = ok(banco, "add", "--valor", "27", "--descricao", "Uber",
      "--categoria", "Uber/99");
    const r = ok(banco, "edit", String(criado.id), "--valor", "37");
    assert.equal(lanc(r).valor_centavos, 3700);
    assert.equal(lanc(r).descricao, "Uber");
    assert.equal(lanc(r).categoria, "Uber/99");
  });

  test("edit sem campos falha", () => {
    const banco = novoBanco();
    const criado = ok(banco, "add", "--valor", "10", "--descricao", "x");
    assert.match(erro(banco, "edit", String(criado.id)), /Nada para alterar/);
  });

  test("edit de id inexistente", () => {
    const banco = novoBanco();
    assert.match(erro(banco, "edit", "999", "--valor", "10"), /#999/);
  });

  test("rm", () => {
    const banco = novoBanco();
    const criado = ok(banco, "add", "--valor", "10", "--descricao", "erro de digitação");
    ok(banco, "rm", String(criado.id));
    assert.equal(ok(banco, "ls", "--periodo", "mes").quantidade_total, 0);
  });

  test("transferência exige destino", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "add", "--tipo", "transferencia", "--valor", "100", "--descricao", "x"),
      /conta-destino/,
    );
  });

  test("transferência não conta como gasto nem receita", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Poupança", "--tipo", "poupanca");
    ok(banco, "add", "--tipo", "transferencia", "--valor", "500", "--descricao", "Guardar",
      "--conta", "Carteira", "--conta-destino", "Poupança");
    const r = ok(banco, "resumo", "--periodo", "mes");
    assert.equal(r.despesas_centavos, 0);
    assert.equal(r.receitas_centavos, 0);
  });

  test("transferência move o saldo entre as contas", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Poupança", "--tipo", "poupanca");
    ok(banco, "add", "--tipo", "receita", "--valor", "1000", "--descricao", "Entrada",
      "--conta", "Carteira", "--categoria", "Salário");
    ok(banco, "add", "--tipo", "transferencia", "--valor", "400", "--descricao", "Guardar",
      "--conta", "Carteira", "--conta-destino", "Poupança");
    const contas = ok(banco, "saldo").contas as { nome: string; saldo_centavos: number }[];
    const saldo = Object.fromEntries(contas.map((c) => [c.nome, c.saldo_centavos]));
    assert.equal(saldo["Carteira"], 60000);
    assert.equal(saldo["Poupança"], 40000);
  });

  test("transferência para a mesma conta falha", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "add", "--tipo", "transferencia", "--valor", "10", "--descricao", "x",
        "--conta", "Carteira", "--conta-destino", "Carteira"),
      /mesma/,
    );
  });

  test("tipo inválido é recusado", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "add", "--valor", "10", "--descricao", "x", "--tipo", "saque"),
      /Tipo inválido/,
    );
  });

  test("opção desconhecida devolve as aceitas", () => {
    const banco = novoBanco();
    const msg = erro(banco, "add", "--valor", "10", "--descricao", "x", "--moeda", "USD");
    assert.match(msg, /--categoria/);
  });
});

describe("parcelas", () => {
  test("divide em meses seguidos", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "1200", "--descricao", "Notebook",
      "--categoria", "Eletrônicos", "--parcelas", "3", "--data", "2026-01-15");
    assert.deepEqual(parcelas(r).map((p) => p.data),
      ["2026-01-15", "2026-02-15", "2026-03-15"]);
    assert.ok(parcelas(r).every((p) => p.valor_centavos === 40000));
  });

  test("não perde centavo na divisão", () => {
    // R$ 100,00 em 3x = 33,34 + 33,33 + 33,33. A soma tem que fechar.
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "100", "--descricao", "Curso",
      "--categoria", "Curso", "--parcelas", "3");
    const valores = parcelas(r).map((p) => Number(p.valor_centavos));
    assert.equal(valores.reduce((a, b) => a + b, 0), 10000);
    assert.deepEqual(valores, [3334, 3333, 3333]);
  });

  test("ajusta dia inexistente no mês seguinte", () => {
    // 31/01 + 1 mês = 28/02, não uma data inválida.
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "300", "--descricao", "Parcelado",
      "--categoria", "Compras", "--parcelas", "3", "--data", "2026-01-31");
    assert.deepEqual(parcelas(r).map((p) => p.data),
      ["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  test("rm --grupo apaga a série inteira", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "900", "--descricao", "TV",
      "--categoria", "Eletrônicos", "--parcelas", "3");
    assert.equal(ok(banco, "rm", String(parcelas(r)[0].id), "--grupo").quantidade, 3);
  });

  test("rm sem --grupo apaga só uma parcela", () => {
    const banco = novoBanco();
    const r = ok(banco, "add", "--valor", "900", "--descricao", "TV",
      "--categoria", "Eletrônicos", "--parcelas", "3");
    assert.equal(ok(banco, "rm", String(parcelas(r)[0].id)).quantidade, 1);
  });

  test("parcelas fora do limite", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "add", "--valor", "10", "--descricao", "x", "--parcelas", "200"),
      /parcelas/,
    );
  });
});

describe("orçamentos", () => {
  test("gasto em subcategoria conta no orçamento do pai", () => {
    // Limite de "Alimentação" tem que capturar o que foi lançado em "Delivery",
    // senão o teto da raiz nunca fecha com a soma das partes.
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Alimentação", "--limite", "500");
    ok(banco, "add", "--valor", "120", "--descricao", "iFood", "--categoria", "Delivery");
    ok(banco, "add", "--valor", "80", "--descricao", "Mercado", "--categoria", "Mercado");
    const s = (ok(banco, "orcamento", "status").orcamentos as never[])[0] as never as
      { gasto_centavos: number; percentual: number };
    assert.equal(s.gasto_centavos, 20000);
    assert.equal(s.percentual, 40);
  });

  test("teto global soma tudo", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--limite", "1000");
    ok(banco, "add", "--valor", "300", "--descricao", "a", "--categoria", "Mercado");
    ok(banco, "add", "--valor", "200", "--descricao", "b", "--categoria", "Uber/99");
    const s = (ok(banco, "orcamento", "status").orcamentos as never[])[0] as never as
      { categoria: string; gasto_centavos: number };
    assert.equal(s.categoria, "Total do mês");
    assert.equal(s.gasto_centavos, 50000);
  });

  test("set repetido não duplica", () => {
    // O UNIQUE do SQLite não pega NULL, então isso já foi bug uma vez.
    const banco = novoBanco();
    for (const limite of ["1000", "2000", "3000"]) {
      ok(banco, "orcamento", "set", "--limite", limite);
    }
    const r = ok(banco, "orcamento", "status");
    const lista = r.orcamentos as { limite_centavos: number }[];
    assert.equal(lista.length, 1);
    assert.equal(lista[0].limite_centavos, 300000);
  });

  test("orçamento do mês tem precedência sobre o recorrente", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "200");
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "800",
      "--mes", mesDe(hoje()));
    const s = (ok(banco, "orcamento", "status").orcamentos as
      { limite_centavos: number; especifico_do_mes: boolean }[])[0];
    assert.equal(s.limite_centavos, 80000);
    assert.equal(s.especifico_do_mes, true);
  });

  test("situações ok / atenção / estourado", () => {
    const banco = novoBanco();
    const situacao = () =>
      (ok(banco, "orcamento", "status").orcamentos as { situacao: string }[])[0].situacao;

    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "100",
      "--alerta", "80");
    ok(banco, "add", "--valor", "50", "--descricao", "Bar", "--categoria", "Bar");
    assert.equal(situacao(), "ok");
    ok(banco, "add", "--valor", "35", "--descricao", "Cinema", "--categoria", "Cinema");
    assert.equal(situacao(), "atencao");
    ok(banco, "add", "--valor", "30", "--descricao", "Show", "--categoria", "Eventos");
    assert.equal(situacao(), "estourado");
  });

  test("add devolve o orçamento afetado", () => {
    // O agente avisa na mesma resposta, sem uma segunda chamada.
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Alimentação", "--limite", "100");
    const r = ok(banco, "add", "--valor", "95", "--descricao", "Mercado",
      "--categoria", "Mercado");
    const o = r.orcamento as { situacao: string; percentual: number };
    assert.equal(o.situacao, "atencao");
    assert.equal(o.percentual, 95);
  });

  test("rm orçamento", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "100");
    ok(banco, "orcamento", "rm", "--categoria", "Lazer");
    assert.equal(ok(banco, "orcamento", "status").quantidade, 0);
  });

  test("mês inválido", () => {
    const banco = novoBanco();
    assert.match(
      erro(banco, "orcamento", "set", "--limite", "100", "--mes", "agosto"),
      /Mês inválido/,
    );
  });
});

describe("alertas", () => {
  test("silencia quando está tudo bem", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "1000");
    ok(banco, "add", "--valor", "10", "--descricao", "Bar", "--categoria", "Bar");
    const r = ok(banco, "alertas");
    assert.equal(r.silent, true);
    assert.deepEqual(r.alertas, []);
  });

  test("não repete o mesmo alerta no mesmo mês", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "100");
    ok(banco, "add", "--valor", "150", "--descricao", "Show", "--categoria", "Eventos");

    const primeiro = ok(banco, "alertas", "--marcar");
    assert.equal(primeiro.quantidade, 1);
    assert.equal((primeiro.alertas as { nivel: string }[])[0].nivel, "estourado");

    assert.equal(ok(banco, "alertas").silent, true);
    assert.equal(ok(banco, "alertas", "--repetir").quantidade, 1);
  });

  test("subir de atenção para estourado é alerta novo", () => {
    const banco = novoBanco();
    ok(banco, "orcamento", "set", "--categoria", "Lazer", "--limite", "100",
      "--alerta", "70");
    ok(banco, "add", "--valor", "75", "--descricao", "Bar", "--categoria", "Bar");
    assert.equal(
      (ok(banco, "alertas", "--marcar").alertas as { nivel: string }[])[0].nivel,
      "atencao",
    );

    ok(banco, "add", "--valor", "40", "--descricao", "Show", "--categoria", "Eventos");
    const r = ok(banco, "alertas", "--marcar");
    assert.equal(r.quantidade, 1);
    assert.equal((r.alertas as { nivel: string }[])[0].nivel, "estourado");
  });
});

describe("relatórios", () => {
  test("resumo agrupa na categoria raiz", () => {
    const banco = novoBanco();
    ok(banco, "add", "--valor", "100", "--descricao", "iFood", "--categoria", "Delivery");
    ok(banco, "add", "--valor", "50", "--descricao", "Mercado", "--categoria", "Mercado");
    ok(banco, "add", "--valor", "30", "--descricao", "Uber", "--categoria", "Uber/99");
    const r = ok(banco, "resumo", "--periodo", "mes");
    const porCat = Object.fromEntries(
      (r.por_categoria as { categoria: string; total_centavos: number }[]).map((c) => [
        c.categoria,
        c.total_centavos,
      ]),
    );
    assert.deepEqual(porCat, { "Alimentação": 15000, Transporte: 3000 });
  });

  test("percentuais somam cem", () => {
    const banco = novoBanco();
    for (const [valor, cat] of [["100", "Mercado"], ["200", "Uber/99"], ["300", "Bar"]]) {
      ok(banco, "add", "--valor", valor, "--descricao", "x", "--categoria", cat);
    }
    const r = ok(banco, "resumo", "--periodo", "mes");
    const total = (r.por_categoria as { percentual: number }[]).reduce(
      (a, c) => a + c.percentual, 0);
    assert.equal(Math.round(total), 100);
  });

  test("comparação de mês civil usa o mês civil anterior", () => {
    const banco = novoBanco();
    ok(banco, "add", "--valor", "100", "--descricao", "jan", "--categoria", "Mercado",
      "--data", "2026-01-10");
    ok(banco, "add", "--valor", "200", "--descricao", "fev", "--categoria", "Mercado",
      "--data", "2026-02-10");
    const r = ok(banco, "resumo", "--periodo", "2026-02");
    assert.equal(r.despesas_centavos, 20000);
    const c = r.comparacao as { despesas_anterior_fmt: string; variacao_pct: number };
    assert.equal(c.despesas_anterior_fmt, "R$ 100,00");
    assert.equal(c.variacao_pct, 100);
  });

  test("relatório gera texto para o Telegram", () => {
    const banco = novoBanco();
    ok(banco, "add", "--valor", "100", "--descricao", "Mercado", "--categoria", "Mercado");
    const texto = ok(banco, "relatorio", "--periodo", "mes").texto as string;
    assert.match(texto, /Gastos/);
    assert.match(texto, /R\$ 100,00/);
    // Sem tabela markdown: o Telegram não renderiza.
    assert.doesNotMatch(texto, /\|---/);
  });

  test("relatório de período vazio não quebra", () => {
    const banco = novoBanco();
    const texto = ok(banco, "relatorio", "--periodo", "2020-01").texto as string;
    assert.match(texto, /Nenhum lançamento/);
  });

  test("média diária", () => {
    const banco = novoBanco();
    ok(banco, "add", "--valor", "310", "--descricao", "x", "--categoria", "Mercado",
      "--data", "2026-01-15");
    const r = ok(banco, "resumo", "--periodo", "2026-01");
    assert.equal(r.dias, 31);
    assert.equal(r.media_diaria_fmt, "R$ 10,00");
  });
});

describe("recorrentes", () => {
  test("aplicar é idempotente", () => {
    // Rodar duas vezes no mesmo dia não pode duplicar o aluguel.
    const banco = novoBanco();
    const ontem = somarDias(hoje(), -1);
    ok(banco, "recorrente", "add", "--descricao", "Aluguel", "--valor", "1500",
      "--categoria", "Aluguel", "--dia", ontem.slice(8));

    const primeiro = ok(banco, "recorrente", "aplicar");
    const segundo = ok(banco, "recorrente", "aplicar");
    assert.equal(segundo.quantidade, 0);
    assert.equal(segundo.silent, true);
    assert.equal(ok(banco, "ls", "--periodo", "tudo").quantidade_total, primeiro.quantidade);
  });

  test("cadastrar não lança retroativo", () => {
    // Cadastrar hoje uma recorrência do dia 1 não deve inventar a cobrança deste
    // mês — ela provavelmente já foi lançada à mão.
    const banco = novoBanco();
    if (Number(hoje().slice(8)) <= 1) return;
    const r = ok(banco, "recorrente", "add", "--descricao", "Aluguel", "--valor", "1500",
      "--categoria", "Aluguel", "--dia", "1");
    assert.ok(String(r.proxima_data) > hoje());
    assert.equal(ok(banco, "recorrente", "aplicar").quantidade, 0);
  });

  test("total mensal fixo", () => {
    const banco = novoBanco();
    ok(banco, "recorrente", "add", "--descricao", "Netflix", "--valor", "44,90",
      "--categoria", "Streaming", "--dia", "5");
    ok(banco, "recorrente", "add", "--descricao", "Aluguel", "--valor", "1500",
      "--categoria", "Aluguel", "--dia", "10");
    assert.equal(ok(banco, "recorrente", "list").total_mensal_fixo_fmt, "R$ 1.544,90");
  });

  test("desativar", () => {
    const banco = novoBanco();
    const r = ok(banco, "recorrente", "add", "--descricao", "Spotify", "--valor", "22",
      "--categoria", "Streaming", "--dia", "3");
    ok(banco, "recorrente", "rm", "--id", String(r.id));
    assert.equal(ok(banco, "recorrente", "list").quantidade, 0);
  });
});

describe("metas", () => {
  test("progresso e aporte necessário", () => {
    const banco = novoBanco();
    ok(banco, "meta", "add", "--nome", "Viagem", "--alvo", "15000", "--inicial", "3000",
      "--prazo", somarDias(hoje(), 300));
    const meta = (ok(banco, "meta", "aportar", "--nome", "viagem", "--valor", "1000")
      .metas as Record<string, unknown>[])[0];
    assert.equal(meta.atual_fmt, "R$ 4.000,00");
    assert.equal(meta.percentual, 26.7);
    assert.equal(meta.falta_fmt, "R$ 11.000,00");
    assert.ok(meta.aporte_mensal_necessario_fmt);
  });

  test("conclusão", () => {
    const banco = novoBanco();
    ok(banco, "meta", "add", "--nome", "Reserva", "--alvo", "1000");
    const meta = (ok(banco, "meta", "aportar", "--nome", "Reserva", "--valor", "1000")
      .metas as { concluida: boolean }[])[0];
    assert.equal(meta.concluida, true);
  });

  test("nome duplicado", () => {
    const banco = novoBanco();
    ok(banco, "meta", "add", "--nome", "Reserva", "--alvo", "1000");
    assert.match(erro(banco, "meta", "add", "--nome", "Reserva", "--alvo", "2000"),
      /Já existe/);
  });

  test("aporte em meta inexistente", () => {
    const banco = novoBanco();
    assert.match(erro(banco, "meta", "aportar", "--nome", "Fantasma", "--valor", "10"),
      /Não achei/);
  });
});

describe("contas", () => {
  test("cartão mostra fatura do mês e limite usado", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Nubank", "--tipo", "cartao",
      "--vencimento", "10", "--limite", "5000");
    ok(banco, "add", "--valor", "300", "--descricao", "Compra", "--categoria", "Compras",
      "--conta", "Nubank");
    const cartao = (ok(banco, "saldo").contas as Record<string, unknown>[])
      .find((c) => c.nome === "Nubank")!;
    assert.equal(cartao.fatura_mes_fmt, "R$ 300,00");
    assert.equal(cartao.limite_usado_pct, 6);
    // Negativo = você deve.
    assert.equal(cartao.saldo_centavos, -30000);
  });

  test("saldo inicial", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Itaú", "--saldo-inicial", "1000");
    const conta = (ok(banco, "saldo").contas as Record<string, unknown>[])
      .find((c) => c.nome === "Itaú")!;
    assert.equal(conta.saldo_centavos, 100000);
  });

  test("nome duplicado", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Itaú");
    assert.match(erro(banco, "conta", "add", "--nome", "Itaú"), /Já existe/);
  });

  test("desativar preserva o histórico", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Antiga");
    ok(banco, "add", "--valor", "50", "--descricao", "x", "--categoria", "Mercado",
      "--conta", "Antiga");
    const r = ok(banco, "conta", "rm", "--nome", "Antiga");
    assert.equal(r.lancamentos_preservados, 1);
    assert.equal(ok(banco, "ls", "--periodo", "mes").quantidade_total, 1);
  });

  test("conta padrão", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Inter");
    ok(banco, "conta", "padrao", "--nome", "Inter");
    const r = ok(banco, "add", "--valor", "10", "--descricao", "x", "--categoria", "Mercado");
    assert.equal(lanc(r).conta, "Inter");
  });

  test("ambiguidade é reportada", () => {
    const banco = novoBanco();
    ok(banco, "conta", "add", "--nome", "Itaú Corrente");
    ok(banco, "conta", "add", "--nome", "Itaú Poupança", "--tipo", "poupanca");
    assert.match(
      erro(banco, "add", "--valor", "10", "--descricao", "x", "--conta", "Itaú"),
      /Mais de uma conta/,
    );
  });

  test("tipo de conta inválido", () => {
    const banco = novoBanco();
    assert.match(erro(banco, "conta", "add", "--nome", "X", "--tipo", "cripto"),
      /Tipo de conta inválido/);
  });
});

describe("consultas e export", () => {
  function povoado(): string {
    const banco = novoBanco();
    ok(banco, "add", "--valor", "100", "--descricao", "Mercado do mês",
      "--categoria", "Mercado", "--tags", "essencial");
    ok(banco, "add", "--valor", "50", "--descricao", "Uber aeroporto",
      "--categoria", "Uber/99");
    ok(banco, "add", "--tipo", "receita", "--valor", "5000", "--descricao", "Salário",
      "--categoria", "Salário");
    return banco;
  }

  test("filtro por categoria inclui as filhas", () => {
    assert.equal(ok(povoado(), "ls", "--categoria", "Alimentação").quantidade_total, 1);
  });

  test("filtro por tipo", () => {
    assert.equal(ok(povoado(), "ls", "--tipo", "receita").quantidade_total, 1);
  });

  test("filtro por tag", () => {
    assert.equal(ok(povoado(), "ls", "--tag", "essencial").quantidade_total, 1);
  });

  test("totais cobrem o filtro inteiro, não a página", () => {
    const r = ok(povoado(), "ls", "--limite", "1");
    assert.equal((r.lancamentos as unknown[]).length, 1);
    assert.equal(r.quantidade_total, 3);
    const totais = r.totais as { despesa: { centavos: number } };
    assert.equal(totais.despesa.centavos, 15000);
  });

  test("busca ignora caixa", () => {
    assert.equal(ok(povoado(), "busca", "MERCADO").quantidade, 1);
  });

  test("export CSV abre no Excel em português", () => {
    const banco = povoado();
    const destino = mkdtempSync(join(tmpdir(), "fin-export-"));
    const r = ok(banco, "export", "--periodo", "mes", "--formato", "csv",
      "--destino", destino);
    assert.equal(r.quantidade, 3);
    const conteudo = readFileSync(r.arquivo as string, "utf8");
    assert.ok(conteudo.startsWith("﻿"), "falta o BOM que o Excel espera");
    assert.match(conteudo, /id;data;tipo/);
    assert.match(conteudo, /100,00/);
  });

  test("export JSON e MD", () => {
    const banco = povoado();
    for (const formato of ["json", "md"]) {
      const destino = mkdtempSync(join(tmpdir(), "fin-export-"));
      const r = ok(banco, "export", "--periodo", "mes", "--formato", formato,
        "--destino", destino);
      assert.ok(existsSync(r.arquivo as string));
    }
  });

  test("formato de export inválido", () => {
    assert.match(erro(novoBanco(), "export", "--formato", "pdf"), /Formato inválido/);
  });
});

describe("schema", () => {
  test("init é idempotente", () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-schema-"));
    const caminho = join(dir, "x.db");
    assert.deepEqual(ok(caminho, "init").migrations_aplicadas, [1]);
    const segundo = ok(caminho, "init");
    assert.deepEqual(segundo.migrations_aplicadas, []);
    const seed = segundo.seed as { categorias: number };
    assert.equal(seed.categorias, 0);
  });

  test("comando em banco novo auto-migra", () => {
    // O agente pode chamar qualquer comando primeiro, sem `init` antes.
    const dir = mkdtempSync(join(tmpdir(), "fin-schema-"));
    const r = ok(join(dir, "novo.db"), "add", "--valor", "10", "--descricao", "primeiro");
    assert.equal(lanc(r).id, 1);
  });

  test("categorias semeadas", () => {
    const r = ok(novoBanco(), "categoria", "list");
    const cats = r.categorias as Record<string, { subcategorias: string[] }>;
    assert.ok(cats["Alimentação"]);
    assert.ok(cats["Alimentação"].subcategorias.includes("Delivery"));
  });

  test("subcomando desconhecido", () => {
    assert.match(erro(novoBanco(), "investir", "--valor", "10"), /desconhecido/);
  });
});
