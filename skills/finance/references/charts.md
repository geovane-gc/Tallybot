# Gráficos

`scripts/chart.ts` gera três gráficos a partir do que já está no banco. Toda
chamada devolve **duas coisas**: um `text` pronto para mandar como mensagem e um
`file` com o PNG. O texto é o que a pessoa olha no dia a dia; a imagem é o extra
de um relatório mensal.

    node chart.ts --db <caminho> --user-id <users.id> \
      --type category|trend|cumulative [--period month] [--months 6] \
      [--month YYYY-MM] [--out <dir>] [--no-png] [--json]

`--user-id` é o **id interno** (`users.id`), não o id do Telegram: a
autenticação acontece em `fin.ts`, antes de chegar aqui.

## Os três tipos

| `--type` | Pergunta que responde | Opção |
|---|---|---|
| `category` | "para onde foi o dinheiro?" — gastos por categoria raiz no período | `--period` (padrão `month`) |
| `trend` | "estou gastando mais que antes?" — gastos mês a mês, com entradas quando existem | `--months` 2..24 (padrão 6) |
| `cumulative` | "vou estourar o mês?" — gasto acumulado por dia com o limite como linha de referência | `--month YYYY-MM` (padrão: mês atual) |

O `cumulative` usa o **orçamento global** (`budgets` com `category_id IS NULL`);
um orçamento do mês específico tem precedência sobre o recorrente, igual ao que
`budget status` e `alerts` mostram.

## Saída

```json
{
  "ok": true,
  "type": "category",
  "title": "📊 Gastos por categoria — este mês",
  "text": "…as barras em bloco, prontas para o Telegram…",
  "file": "/opt/data/finance/charts/tally-u1-category-2026-08-01-a-2026-08-31.png",
  "width": 1600,
  "height": 464,
  "empty": false
}
```

- Mande **sempre** o `text`. Anexe o `file` quando ele não for `null`.
- Período sem gasto nenhum: `"empty": true`, `"file": null` e um `text`
  explicando em português. Não é erro — não force um segundo gráfico.
- Erro: `{"ok": false, "error": "<mensagem em português>"}` e saída 1.
- `--json` acrescenta `data` com os números que geraram o gráfico.
- `--no-png` devolve só o texto (mais rápido, nada é escrito em disco).

O PNG vai para `charts/` ao lado do banco, com o `u<id>` no nome pelo mesmo
motivo que os exports: as duas pessoas escrevem no mesmo diretório.

## Por que barras, e não pizza

Uma pizza com as doze categorias que o bot semeia é ilegível no celular: as
fatias abaixo de 5% viram fios, os rótulos precisam de linha-guia e comparar duas
fatias parecidas por ângulo é justamente o que a gente faz mal. Barras ordenadas
por valor respondem a pergunta ("onde foi o dinheiro") na própria ordem, aguentam
nome comprido e têm tradução direta para a versão em texto.

## A versão em texto

    ████████████ 🏠 Moradia — R$ 2.500,00 (57%)
    ██████░░░░░░ 🍽️ Alimentação — R$ 1.234,56 (28%)
    ███░░░░░░░░░ 🚗 Transporte — R$ 617,28 (14%)

A barra vem **antes** do rótulo de propósito. O Telegram usa fonte proporcional,
então qualquer alinhamento por espaços sai torto (o mesmo motivo pelo qual o
`report` não tem colunas). Com a barra no começo da linha e sempre com o mesmo
número de células, ela fica alinhada em qualquer fonte e em qualquer largura de
tela; o rótulo depois dela fica irregular à direita, que é a aparência normal de
texto.

Não reescreva essas linhas nem "melhore" o alinhamento com espaços — é o que
quebra em telas estreitas.

## Limites conhecidos

- O PNG é rasterizado à mão (sem dependências), com fonte bitmap 5x7 e acentos
  compostos. **Emoji não entram na imagem** — dentro do PNG a categoria aparece
  só pelo nome; o emoji fica na versão em texto.
- Nome de categoria muito comprido é truncado com `…` na imagem e em 20
  caracteres no texto.
- A partir de dez categorias, a cauda vira uma barra só, `Outras (N)`, para os
  percentuais continuarem somando 100%.
