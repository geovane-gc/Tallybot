# Interpretando mensagens em português

Como transformar o que o usuário escreve numa chamada de `fin.ts add`.

Lembre-se: **você não converte valor nem data.** Você extrai o trecho e passa
adiante. A ferramenta faz a conversão, com o fuso e o formato brasileiro certos.

## O formato mínimo

Quase tudo chega como "o que" + "quanto", em qualquer ordem:

    uber 27              → --valor 27    --descricao "Uber"
    27 uber              → --valor 27    --descricao "Uber"
    mercado 234,56       → --valor 234,56 --descricao "Mercado"
    gastei 50 no cinema  → --valor 50    --descricao "Cinema"

O número é o valor; o resto é a descrição. Capitalize a descrição, mas mantenha
os nomes próprios como são ("iFood", "99", "Uber").

## Valores

| Escrito | Passe como | Significa |
|---|---|---|
| `27` | `27` | R$ 27,00 |
| `27,50` / `27.50` | `27,50` | R$ 27,50 |
| `1.234,56` | `1.234,56` | R$ 1.234,56 |
| `R$ 89,90` | `89,90` | R$ 89,90 |
| `1,2k` / `1.2k` | `1,2k` | R$ 1.200,00 |
| `2 mil` | `2k` | R$ 2.000,00 |
| `30 reais` | `30` | R$ 30,00 |
| `27 e 50` | `27,50` | R$ 27,50 |
| `cinquenta reais` | `50` | R$ 50,00 |

Número escrito em palavra: converta só o numeral ("cinquenta" → `50`,
"cento e vinte" → `120`). Se não tiver certeza do que ele quis dizer, pergunte.

**Sinais de ambiguidade — pergunte:**
- `gastei uns 30 e pouco` → "Foi quanto exatamente?"
- `2 e meio` sem contexto → pode ser 2,50 ou 2500.
- Nenhum número na mensagem, mas parece um gasto.

## Datas

Passe o trecho literal em `--data`. Estes valores a ferramenta entende:

`hoje`, `agora`, `ontem`, `anteontem`, `amanha`, `dia 7`, `03/08`,
`03/08/2026`, `2026-08-03`.

Sem `--data`, é hoje — que é o caso da maioria das mensagens.

**Expressões que você precisa traduzir antes**, porque a ferramenta não as
entende. Para estas, primeiro descubra a data de hoje com `date +%F` no
terminal, calcule, e passe em ISO:

- "sexta passada", "no sábado", "segunda"
- "semana passada" (para um lançamento — se for consulta, use `--periodo semana-passada`)
- "no começo do mês", "no dia do meu aniversário"

Se a expressão for vaga demais ("há umas duas semanas"), pergunte a data.

## Contas e formas de pagamento

O usuário mistura conta, banco e forma de pagamento na mesma frase:

    89,90 no ifood no nubank      → --conta Nubank
    paguei no crédito             → --conta <o cartão dele>
    no débito do itaú             → --conta "Itaú"
    pix 50                        → conta padrão (PIX não é conta)
    em dinheiro                   → --conta Carteira
    no vr / no vale               → --conta <o voucher, se cadastrado>

Sem menção de conta, **não pergunte** — vai para a conta padrão. Corrigir depois
é uma mensagem; perguntar a cada gasto é um atrito que faz ele parar de usar o
bot.

Se ele citar uma conta que não existe, o comando falha com "Conta 'X' não
existe". Aí sim: rode `conta list`, mostre as opções e ofereça cadastrar.

## Parcelamento

    3600 em 12x           → --valor 3600 --parcelas 12
    12 vezes de 300       → --valor 3600 --parcelas 12   (300 × 12)
    parcelei em 3         → --parcelas 3

Atenção à diferença: `em 12x` costuma ser o **total**; `12 vezes de 300` é o
valor **da parcela**. Se ele disse o valor da parcela, multiplique e passe o
total — a ferramenta divide de volta sem perder centavo. Em caso de dúvida,
confirme: "R$ 3.600 no total ou 12 parcelas de R$ 3.600?"

## Receita

Palavras que indicam entrada de dinheiro, e exigem `--tipo receita`:

`recebi`, `caiu`, `entrou`, `me pagaram`, `salário`, `pagamento`, `freela`,
`vendi`, `reembolso`, `estorno`, `cashback`, `rendeu`, `dividendo`, `plr`.

Sem nenhuma dessas, assuma despesa — é o caso muito mais comum.

Cuidado com a armadilha: "paguei o freela do designer" é **despesa** (ele
pagou), não receita. Olhe a direção do dinheiro, não só a palavra.

## Transferência

`transferi`, `passei da conta pra`, `mandei pra poupança`, `saquei`,
`paguei a fatura`, `apliquei`.

Exige `--tipo transferencia`, `--conta` (origem) e `--conta-destino`.

Se faltar uma das pontas, pergunte qual conta. Aqui perguntar vale a pena:
transferência com conta errada distorce dois saldos.

## Vários itens numa mensagem

    "30 no almoço e 12 no café"
    "mercado 200, farmácia 45 e uber 18"

Uma chamada de `add` por item. Depois confirme tudo junto:

> ✅ Registrei 3:
> • R$ 200,00 · Mercado (#150)
> • R$ 45,00 · Farmácia (#151)
> • R$ 18,00 · Uber (#152)

## Correções

Referências ao último lançamento — use o id que você acabou de confirmar:

| Ele diz | Ação |
|---|---|
| `não, foi 37` | `edit <id> --valor 37` |
| `era no cartão` | `edit <id> --conta <cartão>` |
| `isso foi ontem` | `edit <id> --data ontem` |
| `era mercado, não restaurante` | `edit <id> --categoria Mercado` |
| `apaga` / `cancela isso` | `rm <id>` |
| `esse era parcelado em 3` | `rm <id>` e `add` de novo com `--parcelas 3` |

Se ele corrige algo que **não** é o último lançamento ("aquele uber de terça
estava errado"), localize com `ls` ou `busca` antes, e confirme qual é o certo
antes de alterar.

## Perguntas versus lançamentos

Nem toda mensagem com número é um gasto:

| Mensagem | É |
|---|---|
| `uber 27` | lançamento |
| `quanto gastei com uber?` | consulta → `ls --categoria "Uber/99" --periodo mes` |
| `limite de 500 pra alimentação` | orçamento → `orcamento set` |
| `quanto tenho na conta?` | consulta → `saldo` |
| `meu aluguel é 1500 todo dia 5` | recorrente → `recorrente add` |
| `quero juntar 15 mil pra viajar` | meta → `meta add` |

Verbo no passado ("gastei", "paguei", "comprei") é lançamento. Pergunta
("quanto", "quais", "como está") é consulta. Intenção futura ("quero", "meu X
é", "todo mês") é configuração — orçamento, recorrente ou meta.

## Mensagens que não são sobre dinheiro

Responda naturalmente e de forma breve. Não force um lançamento, não recite o
menu de funcionalidades. Se ele disse "bom dia", responda bom dia.
