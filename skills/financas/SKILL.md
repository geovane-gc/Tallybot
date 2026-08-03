---
name: financas
description: Controle financeiro pessoal em SQLite
version: 1.0.0
author: Geovane
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    category: financas
    tags: [Finanças, Orçamento, SQLite, Telegram, Relatórios]
    related_skills: [xlsx]
---

# Controle financeiro pessoal

Registra gastos, receitas e transferências em SQLite; controla orçamentos,
despesas fixas, parcelamentos e metas; gera relatórios prontos para enviar no
Telegram.

Tudo passa por um comando só:

    node ${HERMES_SKILL_DIR}/scripts/fin.ts <subcomando> [opções]

Saída sempre JSON: `{"ok": true, ...}` ou `{"ok": false, "erro": "..."}`. Quando
vier `ok: false`, o texto de `erro` foi escrito para ser mostrado ao usuário —
repasse ou resolva. Nunca relate sucesso sem ter visto `ok: true`.

## Quando usar

Qualquer mensagem sobre dinheiro: um gasto, uma receita, uma pergunta sobre
saldo, um pedido de relatório, definir um limite, cadastrar uma conta.

## As três regras

1. **Nunca invente número.** Todo valor que você responde vem de uma chamada da
   ferramenta. Não some, não calcule média, não estime percentual de cabeça.
2. **Nunca calcule data.** Passe a expressão do usuário direto em `--data`
   (`hoje`, `ontem`, `03/08`, `dia 7`, `2026-08-03`). Você não sabe que dia é
   hoje; a ferramenta sabe, e resolve no fuso de São Paulo.
3. **Nunca converta valor.** Passe como ele escreveu (`27`, `89,90`,
   `1.234,56`, `1,2k`, `30 reais`). A ferramenta lê o formato brasileiro.

## Registrar um lançamento

    fin.ts add --valor <v> --descricao "<texto>" [--categoria <c>] [--conta <c>]
               [--data <d>] [--tipo despesa|receita|transferencia]
               [--tags "a,b"] [--parcelas N] [--obs "<texto>"]
               [--conta-destino <c>]

Defaults: `--tipo despesa`, `--data` hoje, `--conta` a conta padrão.

| O usuário diz | Comando |
|---|---|
| `uber 27` | `add --valor 27 --descricao "Uber" --categoria "Uber/99"` |
| `mercado 234,56` | `add --valor 234,56 --descricao "Mercado" --categoria Mercado` |
| `89,90 ifood ontem no nubank` | `add --valor 89,90 --descricao "iFood" --categoria Delivery --conta Nubank --data ontem` |
| `pix 50 pra minha mãe` | `add --valor 50 --descricao "PIX para minha mãe" --categoria Família` |
| `recebi 7500 de salário` | `add --tipo receita --valor 7500 --descricao "Salário" --categoria Salário` |
| `notebook 3600 em 12x no nubank` | `add --valor 3600 --descricao "Notebook" --categoria Eletrônicos --conta Nubank --parcelas 12` |
| `transferi 500 da conta pra poupança` | `add --tipo transferencia --valor 500 --descricao "Transferência" --conta "Itaú" --conta-destino Poupança` |

### Confirmação

Uma linha, com o id no fim (é como o usuário corrige depois):

> ✅ R$ 27,00 · Uber · hoje · Carteira (#142)

A resposta do `add` já traz o campo `orcamento` com a situação do limite que
cobre aquela categoria. Se `situacao` for `atencao` ou `estourado`, acrescente
uma segunda linha — **não faça outra chamada para descobrir isso**:

> 🟡 Alimentação: R$ 450,00 de R$ 500,00 este mês.

Parcelado: confirme o total, o valor da parcela e quando termina.

> ✅ Notebook R$ 3.600,00 em 12x de R$ 300,00 · Nubank (#150)
> Última parcela em 03/07/2027.

### Vários gastos numa mensagem

"gastei 30 no almoço e 12 no café" são dois lançamentos: duas chamadas de `add`.
Confirme os dois numa única resposta.

### Quando perguntar

Faça **uma** pergunta curta, e só se faltar algo essencial:

- **Valor ausente ou incompreensível** → pergunte. Nunca chute.
- **Descrição vaga demais** ("gastei 50") → pergunte com o quê.
- **Categoria incerta** → não pergunte. Escolha a mais provável e registre; se
  errou, ele corrige. Registrar em `Outros` é melhor que travar a conversa.
- **Conta não informada** → não pergunte. Vai para a conta padrão.

## Corrigir e apagar

    fin.ts edit <id> [--valor v] [--descricao t] [--categoria c] [--conta c]
                     [--data d] [--tipo t] [--tags "a,b"] [--obs t]
    fin.ts rm <id> [--grupo]

Só os campos informados mudam; o resto fica como está. `--grupo` apaga a série
inteira de parcelas (use quando ele diz "cancela aquele parcelamento").

"não, foi 37", "era no cartão", "isso foi ontem" se referem ao último
lançamento que você confirmou — use aquele id.

## Consultar

    fin.ts resumo --periodo <p> [--sem-comparacao]
    fin.ts ls [--periodo p] [--categoria c] [--conta c] [--tipo t] [--tag t]
              [--texto t] [--limite N] [--ordem asc|desc]
    fin.ts busca "<termo>" [--limite N]
    fin.ts saldo

Períodos aceitos: `hoje`, `ontem`, `semana`, `semana-passada`, `mes`,
`mes-passado`, `mes-completo`, `ano`, `ano-passado`, `7d`, `30d`, `90d`,
`2026-08`, `tudo`.

`resumo` traz totais, quebra por categoria e por conta, maiores gastos, média
diária e comparação com o período anterior. É o que você usa para responder
"quanto gastei esse mês?" — mas **responda com poucas linhas**, não despeje o
JSON inteiro:

> 💸 Este mês: R$ 1.724,46 em 12 lançamentos.
> Maior fatia: Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

`saldo` lista as contas. Em cartão de crédito, o saldo negativo é o quanto ele
deve; `fatura_mes_fmt` é o gasto do mês corrente naquele cartão.

## Relatórios

    fin.ts relatorio --periodo <p> [--titulo "<t>"] [--top N] [--com-dados]

Devolve `texto` já formatado para o Telegram. **Envie exatamente como veio** —
não reescreva, não resuma, não converta em outro formato. Ele já traz gastos,
receitas, resultado, comparação com o período anterior, ranking de categorias,
maiores gastos e situação dos orçamentos.

## Orçamentos

    fin.ts orcamento set --limite <v> [--categoria <c>] [--mes YYYY-MM] [--alerta N]
    fin.ts orcamento status [--mes YYYY-MM]
    fin.ts orcamento rm [--categoria <c>] [--mes YYYY-MM]

Sem `--categoria`, o limite é o teto **total** do mês. Sem `--mes`, vale para
todos os meses (é o caso normal). `--alerta` é o percentual do aviso amarelo
(default 80).

Um limite numa categoria raiz captura as subcategorias: teto em `Alimentação`
inclui o que foi lançado em `Delivery`, `Mercado` e `Restaurante`.

| O usuário diz | Comando |
|---|---|
| `limite de 500 pra alimentação` | `orcamento set --categoria Alimentação --limite 500` |
| `não quero gastar mais de 4 mil por mês` | `orcamento set --limite 4000` |
| `como estão meus limites?` | `orcamento status` |

## Contas e cartões

    fin.ts conta add --nome <n> [--tipo conta|cartao|dinheiro|poupanca|investimento|voucher]
                     [--instituicao i] [--vencimento D] [--fechamento D]
                     [--limite v] [--saldo-inicial v]
    fin.ts conta list
    fin.ts conta padrao --nome <n>
    fin.ts conta rm --nome <n>

`conta rm` desativa e **preserva o histórico** — nada é apagado.

Exemplo: `cadastra meu cartão do nubank, vence dia 10, limite 5 mil` →
`conta add --nome Nubank --tipo cartao --instituicao Nubank --vencimento 10 --limite 5000`

## Despesas fixas

    fin.ts recorrente add --descricao <d> --valor <v> [--categoria c] [--conta c]
                          [--frequencia mensal|semanal|anual] [--dia D] [--fim data]
                          [--tipo despesa|receita]
    fin.ts recorrente list
    fin.ts recorrente aplicar
    fin.ts recorrente rm --id <id>

`aplicar` gera os lançamentos vencidos e é idempotente — rodar duas vezes não
duplica nada. O cron já chama isso diariamente; você raramente precisa.

Ao cadastrar, a primeira cobrança automática é a **próxima** ocorrência, nunca
retroativa: se hoje é dia 12 e ele cadastra o aluguel do dia 5, o registro
automático começa no mês seguinte. Avise, e ofereça lançar o deste mês à mão:

> ✅ Aluguel de R$ 1.500,00 todo dia 5. A cobrança automática começa em 05/09.
> Quer que eu registre o de agosto agora?

## Metas

    fin.ts meta add --nome <n> --alvo <v> [--inicial v] [--prazo data]
    fin.ts meta list
    fin.ts meta aportar --nome <n> --valor <v>
    fin.ts meta rm --nome <n>

A listagem já calcula percentual, quanto falta e o aporte mensal necessário
para bater o prazo.

## Export

    fin.ts export --periodo <p> [--formato csv|json|md] [--destino <dir>]

CSV é o default e abre direto no Excel em português (separador `;`, vírgula
decimal). A resposta traz `arquivo` com o caminho — para entregar o arquivo no
Telegram, cite o caminho na sua resposta e o gateway anexa. Se for um arquivo
que não deve virar preview de imagem, termine a resposta com `[[as_document]]`.

## Categorias

    fin.ts categoria list
    fin.ts categoria add --nome <n> [--pai <p>] [--tipo despesa|receita|ambos] [--emoji e]

O banco já vem com 17 categorias e ~70 subcategorias em português. Passe o nome
que o usuário usou — a busca ignora acento, maiúscula e plural, e prefere a
subcategoria mais específica. Se não existir, a categoria é criada sob `Outros`
em vez de o lançamento falhar.

Mapeamento completo de termos para categorias: `references/categorias.md`.
Use `skill_view` com esse caminho quando estiver em dúvida sobre onde encaixar
algo recorrente.

## Erros comuns

| Sintoma | Causa e saída |
|---|---|
| `Conta 'X' não existe` | Nome errado. Rode `conta list` e confirme com o usuário, ou use a conta padrão. |
| `Mais de uma conta casa com 'Itaú'` | Ambíguo. Mostre as opções e pergunte qual. |
| `Descrição é obrigatória` | Você não passou `--descricao`. Nunca omita. |
| `O valor precisa ser maior que zero` | Valor não veio ou veio zero. Pergunte. |
| `Não entendi a data` | Passe `hoje`/`ontem`/`DD/MM` em vez de texto livre. |
| `Não achei o lançamento #N` | Id errado. Use `ls` para localizar. |

## Referências

Carregue com `skill_view` quando precisar:

- `references/categorias.md` — taxonomia completa e de que forma mapear
  termos do dia a dia ("ifood" → Delivery, "99" → Uber/99).
- `references/parsing-ptbr.md` — como interpretar mensagens em português:
  valores, datas, formas de pagamento, múltiplos itens, correções.
- `references/relatorios.md` — o que cada relatório contém e como apresentar
  cada período no chat.
- `references/schema.md` — schema do banco, para consultas que a CLI não cobre.

## Verificação

Antes de confirmar qualquer coisa ao usuário:

1. A saída trouxe `"ok": true`?
2. O `valor_fmt` confere com o que ele disse?
3. A `data` é a que ele indicou?
4. Você citou o `id` na confirmação?

Se registrou algo errado, corrija com `edit` e diga o que mudou — não deixe
passar em silêncio.
