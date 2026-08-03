# financas-bot

Agente financeiro pessoal no Telegram. Você manda "uber 27", ele categoriza,
guarda em SQLite e devolve relatórios, alertas de limite e fechamentos mensais.

Construído sobre o [Hermes Agent](https://github.com/NousResearch/hermes-agent)
da Nous Research, rodando em Docker, com modelo gratuito via OpenRouter.

```
você  ─────────►  Telegram  ─────────►  Hermes (container)
                                            │
                                            ├─ SOUL.md ......... persona e caminho rápido
                                            ├─ skill financas .. referência completa
                                            ├─ fin.ts .......... toda a lógica financeira
                                            └─ SQLite .......... seus dados, no seu disco
```

## Como funciona uma conversa

```
você:  mercado 234,56
bot:   ✅ R$ 234,56 · Mercado · hoje · Nubank (#87)

você:  89,90 no ifood ontem
bot:   ✅ R$ 89,90 · Delivery · ontem · Nubank (#88)
       🟡 Alimentação: R$ 324,46 de R$ 400,00 este mês.

você:  quanto gastei esse mês?
bot:   💸 R$ 1.724,46 este mês, em 12 lançamentos.
       A maior fatia foi Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

você:  limite de 500 pra alimentação
bot:   ✅ Limite de R$ 500,00 em Alimentação. Aviso quando chegar a 80%.

você:  notebook 3600 em 12x no nubank
bot:   ✅ Notebook R$ 3.600,00 em 12x de R$ 300,00 · Nubank (#89)
       Última parcela em 03/07/2027.
```

Além disso, sem você pedir: resumo do dia às 21h, fechamento da semana no
domingo, fechamento do mês com planilha no dia 1º, e alerta quando um limite
aperta.

## O que ele faz

| | |
|---|---|
| **Lançamentos** | Despesas, receitas e transferências em texto livre em português. Parcelamento, tags, correção e remoção. |
| **Contas** | Contas correntes, cartões (com fatura e limite), dinheiro, poupança, investimento e vouchers. |
| **Categorias** | 17 categorias e ~70 subcategorias em PT-BR, hierárquicas, já semeadas. |
| **Orçamentos** | Limite por categoria ou teto total do mês, com aviso antes de estourar. |
| **Despesas fixas** | Aluguel, assinaturas e afins, lançados automaticamente. |
| **Metas** | Objetivo de economia com prazo e cálculo do aporte mensal necessário. |
| **Relatórios** | Por dia, semana, mês, ano ou período arbitrário, com comparação. |
| **Export** | CSV que abre direto no Excel em português, mais JSON e Markdown. |

Entrada por **áudio** e por **foto de comprovante** ficaram fora desta versão de
propósito, mas o caminho está preparado — veja [docs/roadmap.md](docs/roadmap.md).

## Começando

Você precisa de Docker e de três coisas:

1. **Token do bot** — mande `/newbot` para o [@BotFather](https://t.me/BotFather).
2. **Seu ID do Telegram** — mande `/start` para o [@userinfobot](https://t.me/userinfobot).
3. **Chave da OpenRouter** — em [openrouter.ai/keys](https://openrouter.ai/keys).

```bash
cp .env.example .env
$EDITOR .env          # preencha os três valores acima
make up               # valida, prepara o banco e sobe o container
make cron-install     # agenda os relatórios e os alertas
```

Mande uma mensagem para o seu bot no Telegram. O passo a passo detalhado, com as
telas do BotFather, está em [docs/setup.md](docs/setup.md).

## Comandos

```bash
make up            # sobe o bot
make down          # para
make logs          # acompanha o que o bot está fazendo
make restart       # aplica mudanças em hermes/config.yaml ou SOUL.md
make chat          # conversa pelo terminal, sem passar pelo Telegram
make doctor        # diagnóstico: chaves, modelo, gateway
make backup        # backup consistente do banco
make test          # roda a suíte de testes
make saldo         # consulta direta, sem gastar requisição do modelo
make relatorio
```

## Sobre o custo

O modelo é `nvidia/nemotron-3-ultra-550b-a55b:free` — sem custo por token.

O que **tem** limite é o número de requisições: a OpenRouter libera ~50 por dia
para contas sem crédito, e cada mensagem sua consome de 2 a 4 (o agente chama a
ferramenta e lê o resultado). Na prática, 50/dia é apertado.

Comprando **US$ 10 de crédito uma única vez**, o limite sobe para ~1000/dia e o
crédito não é consumido pelos modelos `:free`. É o único gasto recomendado.

Para trocar de modelo, altere `model.default` em
[hermes/config.yaml](hermes/config.yaml) e rode `make restart`.

## Estrutura

```
├── docker-compose.yml      Container, volumes e limites de recurso
├── hermes/
│   ├── config.yaml         Modelo, toolsets, guardrails  (fonte da verdade)
│   ├── SOUL.md             Persona e o caminho rápido de lançamento
│   └── cron-jobs.sh        Cria os relatórios agendados
├── skills/financas/
│   ├── SKILL.md            Referência completa que o agente carrega
│   ├── scripts/
│   │   ├── fin.ts          CLI: toda a lógica financeira
│   │   └── db.ts           Schema, migrations e parsing de valor/data
│   └── references/         Categorias, parsing PT-BR, relatórios, schema
├── scripts/                bootstrap e backup
├── tests/                  122 testes, rodam sem credenciais
├── docs/
└── data/                   Estado e banco (fora do git)
```

## Como isso foi construído

TypeScript sem nenhuma dependência: `node:sqlite` para o banco, `node:util` para
os argumentos, e o Node 26 da própria imagem do Hermes executa `.ts` direto, sem
build step. Não existe `node_modules`, `tsconfig` nem bundler para manter.

Quatro decisões que explicam o resto do código:

**Dinheiro é inteiro em centavos, nunca float** — e com tipo marcado
(`Centavos`), o que impede passar reais onde se espera centavos. `R$ 0,10` somado
cem vezes tem que dar exatamente `R$ 10,00`; com float daria 9,999999999999998, e
o erro se acumularia em cada relatório mensal. Há teste cobrindo isso.

**O modelo não calcula nada.** Nenhuma soma, data ou percentual passa pelo LLM.
Ele decide *o que* registrar; o `fin.ts` decide *como*. Isso importa porque o
Hermes não coloca a data atual no prompt (ele instrui o agente a rodar `date`),
então um modelo tentando resolver "ontem" na própria cabeça erraria. Em vez
disso, `--data ontem` é resolvido pelo script, com o fuso de São Paulo.

**O caminho quente não custa um turno extra.** Registrar um gasto é 90% do uso,
então esse fluxo vive no `SOUL.md`, que é injetado em toda sessão. A skill guarda
a cauda longa e só é carregada quando necessário. Menos ida e volta, menos
requisição, menos chance de erro.

Detalhes em [docs/arquitetura.md](docs/arquitetura.md).

## Documentação

- [docs/setup.md](docs/setup.md) — instalação passo a passo
- [docs/uso.md](docs/uso.md) — tudo que você pode dizer ao bot
- [docs/arquitetura.md](docs/arquitetura.md) — como as peças se encaixam
- [docs/deploy.md](docs/deploy.md) — subir num VPS para ficar 24/7
- [docs/roadmap.md](docs/roadmap.md) — áudio, foto e outras evoluções

## Licença

MIT. Uso pessoal.
