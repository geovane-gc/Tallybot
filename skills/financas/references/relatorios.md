# Relatórios e como apresentá-los

## `relatorio` — texto pronto

    fin.ts relatorio --periodo <p> [--titulo "<t>"] [--top N] [--com-dados]

O campo `texto` da resposta já vem formatado para o Telegram. **Envie como
veio.** Não reescreva, não resuma, não acrescente introdução. Reescrever só
introduz erro de número e desperdiça contexto.

Contém, nesta ordem: período · gastos · entradas · resultado · comparação com o
período anterior · ranking de categorias com percentual · cinco maiores gastos ·
orçamentos em atenção ou estourados.

`--top` controla quantas categorias entram no ranking (default 8). Para o resumo
diário, `--top 3` é mais legível.

## `resumo` — dados crus

    fin.ts resumo --periodo <p> [--sem-comparacao]

Use quando ele faz uma pergunta específica, não quando pede "o relatório".
Campos úteis:

| Campo | O que é |
|---|---|
| `despesas_fmt` / `receitas_fmt` | Totais do período |
| `resultado_fmt` | Entradas menos saídas |
| `media_diaria_fmt` | Gasto médio por dia do período |
| `quantidade` | Número de lançamentos |
| `por_categoria[]` | Ranking com `total_fmt` e `percentual` |
| `por_conta[]` | Quanto saiu de cada conta |
| `maiores_gastos[]` | Os 10 maiores, com descrição e data |
| `comparacao.variacao_pct` | Variação % contra o período anterior |

Responda com duas ou três linhas, escolhendo o que responde a pergunta dele.
Nunca despeje a estrutura inteira.

**"quanto gastei esse mês?"**
> 💸 R$ 1.724,46 este mês, em 12 lançamentos.
> A maior fatia foi Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

**"quanto gastei com comida?"**
> 🍽️ R$ 389,40 em Alimentação este mês — R$ 12,98 por dia.
> A maior parte em Delivery (R$ 210,00).

**"tô gastando muito?"** — informe, não julgue. Compare com o histórico dele e
com os limites que ele mesmo definiu, e pare aí.
> Este mês está em R$ 1.724,46, 8% abaixo do mês passado.
> Dos seus limites, só Alimentação está apertado: 90% usado.

## Comparação entre períodos

O `resumo` compara automaticamente com a janela anterior de mesmo tamanho. Para
um mês civil completo, o comparativo é o mês civil anterior — não "30 dias
atrás", que atravessaria a virada do mês e daria número errado.

Para comparar dois meses específicos, chame `resumo` duas vezes:

    fin.ts resumo --periodo 2026-07 --sem-comparacao
    fin.ts resumo --periodo 2026-08 --sem-comparacao

## Os relatórios agendados

O cron dispara quatro rotinas. Elas chegam a você como uma instrução normal; o
que muda é que ninguém está esperando na linha.

| Quando | O que fazer |
|---|---|
| Todo dia, 21h | `relatorio --periodo hoje --top 3`. Se não houve lançamento, responda só `[SILENT]`. |
| Domingo, 20h | `relatorio --periodo semana`, com uma frase de fechamento da semana. |
| Dia 1º, 9h | `relatorio --periodo mes-passado --titulo "Fechamento de <mês>"`. |
| A cada 3h | `alertas --marcar`. Se `silent` for `true`, responda só `[SILENT]`. |

**A regra do `[SILENT]`:** quando não há nada a dizer, sua resposta tem que ser
exatamente `[SILENT]`, sem mais nada. O gateway reconhece esse marcador e não
entrega mensagem nenhuma. Se você responder "hoje não houve gastos", ele recebe
uma notificação inútil — e um bot que notifica sem motivo é um bot que ele vai
silenciar.

## Export

    fin.ts export --periodo <p> [--formato csv|json|md] [--destino <dir>]

CSV (default) abre direto no Excel em português: separador `;`, vírgula decimal
e UTF-8 com BOM. A resposta traz `arquivo` com o caminho completo — cite esse
caminho na sua resposta e o gateway anexa o arquivo no Telegram.

Para planilha `.xlsx` de verdade, existe a skill `xlsx` do Hermes: exporte em
CSV primeiro e converta com ela.

## O que nunca fazer num relatório

- Inventar ou arredondar número que não veio da ferramenta.
- Recalcular percentual "para conferir".
- Emitir juízo sobre um gasto ("gastou muito com delivery"). Mostre o número.
- Recomendar corte sem ele pedir. Se pedir, aí sim sugira, com base nos dados.
- Usar tabela markdown: o Telegram não renderiza, chega como texto embolado.
