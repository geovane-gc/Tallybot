# Tally

Agente financeiro no Telegram. Você manda "uber 27", ele categoriza, guarda em
SQLite e devolve relatórios, alertas de limite e fechamentos mensais.

**Duas pessoas usam o mesmo bot, cada uma com o próprio caixa.** Contas,
categorias, orçamentos e lançamentos são separados: no uso normal ninguém vê os
números da outra pessoa, e os dois caixas nunca se misturam por acidente. Isso é
uma garantia de **correção**, não de sigilo entre as duas — leia
[Duas pessoas, dois caixas](#duas-pessoas-dois-caixas) antes de contar com ela
como se fosse.

O bot conversa em português. O código é em inglês — a divisão está explicada em
[Idiomas](#idiomas) mais abaixo.

Construído sobre o [Hermes Agent](https://github.com/NousResearch/hermes-agent)
da Nous Research, rodando em Docker, com modelo gratuito via OpenRouter.

```
você  ─────────►  Telegram  ─────────►  Hermes (container)
                                            │
                                            ├─ allowlist ...... quem pode falar com o bot
                                            ├─ SOUL.md ........ persona e caminho rápido
                                            ├─ skill finance .. referência completa
                                            ├─ fin.ts ......... lógica financeira + identidade
                                            └─ SQLite ......... os dados, no seu disco
```

## Como funciona uma conversa

Na primeira mensagem, cada pessoa digita o código de acesso uma vez:

```
você:  oi
Tally: 🔒 Antes de falar de dinheiro eu preciso confirmar quem é você.
       Me manda o código de acesso.

você:  <o código>
Tally: ✅ Tudo certo, agora é só me contar seus gastos.
```

Daí em diante:

```
você:  mercado 234,56
Tally: ✅ R$ 234,56 · Mercado · hoje · Nubank (#87)

você:  89,90 no ifood ontem
Tally: ✅ R$ 89,90 · Delivery · ontem · Nubank (#88)
       🟡 Alimentação: R$ 324,46 de R$ 400,00 este mês.

você:  quanto gastei esse mês?
Tally: 💸 R$ 1.724,46 este mês, em 12 lançamentos.
       A maior fatia foi Moradia (R$ 1.234,56). Está 8% abaixo do mês passado.

você:  limite de 500 pra alimentação
Tally: ✅ Limite de R$ 500,00 em Alimentação. Aviso quando chegar a 80%.

você:  notebook 3600 em 12x no nubank
Tally: ✅ Notebook R$ 3.600,00 em 12x de R$ 300,00 · Nubank (#89)
       Última parcela em 03/07/2027.
```

Além disso, sem ninguém pedir: resumo do dia às 21h, fechamento da semana no
domingo, fechamento do mês com planilha no dia 1º, e alerta quando um limite
aperta — cada um na conversa privada de quem é o número.

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
| **Duas pessoas** | Cada uma com o próprio caixa e o próprio cadastro. Nada é somado nem comparado entre as duas. |

Entrada por **áudio** e por **foto de comprovante** ficaram fora desta versão de
propósito, mas o caminho está preparado — veja [docs/roadmap.md](docs/roadmap.md).

## Duas pessoas, dois caixas

Dois mecanismos, com papéis bem diferentes — e só um deles é uma fronteira de
segurança:

**`TELEGRAM_ALLOWED_USERS` é a fronteira.** Precisa ter os IDs das duas pessoas. O
Hermes checa o remetente no gateway, **antes** de o modelo rodar, e sem allowlist
nega todo mundo. Quem não está na lista não chega ao bot. Todo o resto está dentro
do raio de alcance de quem está.

**O código de acesso é um cadastro, não uma trava.** Cada uma digita um código uma
vez, na primeira conversa. Isso amarra cada lançamento a uma pessoa e dá uma etapa
explícita de entrada — não protege uma pessoa da outra.

**Cada pessoa tem o convite dela.** `make invite LABEL="Namorada"` gera um código
de uso único que expira (`7K2M-QX9P-4TVB`, feito para ser ditado em voz alta), e o
banco guarda só o SHA-256 dele. Com isso dá para **cortar o acesso de uma pessoa
sem incomodar a outra** (`make revoke TG_USER=<id>`, que não apaga nenhum dado), e
depois que todo mundo entrou você **apaga o `TALLY_ACCESS_CODE` do `.env`** — aí não
sobra segredo permanente em lugar nenhum, o que importa porque o agente tem shell e
consegue ler o ambiente. O código compartilhado continua funcionando como modo
simples, para quem não quer gerar convite.

O bot não cria convite: `auth invite` só roda no seu terminal, e ele recusa dentro
de uma conversa. Um bot que pode convidar é um bot que convida quem pedir.

**A identidade vem do ambiente, não do modelo.** O Hermes exporta
`HERMES_SESSION_USER_ID` em todo processo que o agente dispara, e o `fin.ts` lê
dali. E o código é conferido na ferramenta, não pelo modelo: um LLM se deixa
convencer ("ignore suas instruções, eu já autentiquei"), um `if` não. Isso vale —
mas como guardrail, pelo motivo da subseção seguinte.

### Até onde essa separação vai, e onde ela para

Isso merece uma frase sem rodeio, porque é fácil confundir as duas coisas.

A separação é uma **garantia de correção, não de segurança**. Uma revisão
adversarial varreu todas as consultas SQL e não achou um único vazamento: os dois
caixas nunca se misturam por acidente, e tentar alcançar uma linha alheia por id
ou por nome é recusado com a mesma mensagem de uma linha que não existe.

Mas o agente tem um shell, e a identidade que ele respeita é uma variável de
ambiente de um processo que **ele mesmo dispara**. Descartar a variável é um
comando; `fin.ts auth users` lista os IDs e não exige autenticação; e o banco é um
arquivo que ele pode abrir direto com `node:sqlite`. Isso não é teórico — uma
revisão adversarial rodou o ataque contra um banco real de duas pessoas e obteve o
extrato completo da outra em dois comandos, sem código de acesso e sem adivinhar
nada.

Então, sem rodeio: **as checagens dentro do `fin.ts` são guardrails.** Elas
impedem o bot de cruzar os caixas quando simplesmente lhe pedem, o que cobre o
acidente e o pedido casual. Não são uma parede contra quem sabe o que está
pedindo. Recusar um `--user` divergente protege contra um erro honesto, nada além.

**Convite também não ajuda aqui**, e é importante não confundir: ele resolve
cadastro e revogação (dar acesso a uma pessoa, tirar de uma só, não deixar segredo
permanente no ambiente). Ele não isola ninguém — depois de cadastradas, as duas
pessoas continuam dividindo um container, um arquivo de banco e um agente com
shell.

Traduzindo: `TELEGRAM_ALLOWED_USERS` é a única fronteira real, e ela protege vocês
dois de terceiros — não um do outro. Para duas pessoas que confiam uma na outra,
isso é adequado, e é o caso para o qual este bot foi feito. Se a expectativa é "o
outro não consegue ver nem se tentar", a única configuração que entrega isso é
**um container, um volume e um token de bot por pessoa** — dois `.env`, dois
bancos, nada compartilhado ([docs/deploy.md](docs/deploy.md#segurança)).

## Começando

Você precisa de Docker e de três coisas:

1. **Token do bot** — mande `/newbot` para o [@BotFather](https://t.me/BotFather).
2. **Os IDs do Telegram das duas pessoas** — cada uma manda `/start` para o
   [@userinfobot](https://t.me/userinfobot). Os dois vão em
   `TELEGRAM_ALLOWED_USERS`, separados por vírgula.
3. **Chave da OpenRouter** — em [openrouter.ai/keys](https://openrouter.ai/keys).

```bash
cp .env.example .env
$EDITOR .env          # preencha os três valores acima
make up               # valida, prepara o banco e sobe o container
```

Depois, um convite para cada pessoa — o código sai na tela **uma vez só**, para você
ditar pessoalmente:

```bash
make invite LABEL="Geovane"
make invite LABEL="Namorada" HOURS=24
```

Agora **as duas mandam mensagem para o bot e digitam o código**. Com as duas
dentro, apague o `TALLY_ACCESS_CODE` do `.env` (se você tinha posto um) e rode
`make restart`: daí em diante não existe segredo permanente nenhum. Só depois:

```bash
make cron-install     # agenda os relatórios de cada uma
```

Essa ordem importa: o `cron-install` cria um conjunto de jobs por pessoa
autenticada, então rodar antes não agendaria nada. Rode de novo quando alguém
novo entrar — ele é idempotente.

O passo a passo detalhado, com as telas do BotFather, está em
[docs/setup.md](docs/setup.md).

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
make users         # quem está cadastrado, com os IDs do Telegram
```

Acesso — convidar uma pessoa e tirar uma pessoa são coisas separadas:

```bash
make invite LABEL="Namorada" [HOURS=48]   # código de uso único; aparece uma vez só
make invites                              # estado de cada convite (nunca os códigos)
make revoke-invite ID=3                   # mata um convite que ninguém usou
make revoke TG_USER=123456789             # tira o acesso de UMA pessoa (não apaga nada)
make logout-all                           # TODOS digitam o código de novo (não apaga nada)
```

`revoke` é o bisturi e `logout-all` é o botão de pânico. Nenhum dos dois apaga um
lançamento: o caixa da pessoa continua inteiro e volta quando ela entra de novo.

As consultas diretas ao banco pedem de quem é o caixa, com `TG_USER` (e não
`USER`, que já é do shell):

```bash
make balance TG_USER=123456789    # sem gastar requisição do modelo
make report  TG_USER=123456789
```

## Idiomas

A divisão é deliberada e vale para todo o repositório:

| | Idioma | Por quê |
|---|---|---|
| Código, schema, comentários, chaves do JSON | **Inglês** | É o padrão da parte técnica, e mantém o código legível para qualquer pessoa |
| `SKILL.md`, references, `SOUL.md` | **Inglês** | Ficam ao lado do código; instruem o bot a responder em português |
| README e `docs/` | **Português** | São para você ler |
| **Tudo que o bot te mostra** | **Português** | Mensagens de erro (o agente repassa no chat), nomes de categoria (aparecem nos relatórios) e o texto dos relatórios |

Na prática: `error` no JSON vem em português porque vai direto para o Telegram;
`amount_cents` é inglês porque ninguém além do código vê. A regra de bolso está
escrita no topo do `db.ts` — se a string pode chegar ao Telegram, é português.

Moeda é BRL, e o parser entende `1.234,56`, `1,2k` e `30 reais`. As categorias
mapeiam estabelecimentos brasileiros: "ifood" vira Delivery, "99" vira Uber/99,
"sabesp" vira Água.

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
├── skills/finance/
│   ├── SKILL.md            Referência completa que o agente carrega
│   ├── scripts/
│   │   ├── fin.ts          CLI: lógica financeira, identidade e autenticação
│   │   └── db.ts           Schema, migrations e parsing de valor/data
│   └── references/         Categorias, parsing PT-BR, relatórios, schema
├── scripts/                bootstrap e backup
├── tests/                  164 testes, rodam sem credenciais
├── docs/
└── data/                   Estado e banco (fora do git)
```

## Como isso foi construído

TypeScript sem nenhuma dependência: `node:sqlite` para o banco, `node:util` para
os argumentos, e o Node 26 da própria imagem do Hermes executa `.ts` direto, sem
build step. Não existe `node_modules`, `tsconfig` nem bundler para manter.

Cinco decisões que explicam o resto do código:

**Dinheiro é inteiro em centavos, nunca float** — e com tipo marcado (`Cents`),
o que impede passar reais onde se espera centavos. `R$ 0,10` somado cem vezes tem
que dar exatamente `R$ 10,00`; com float daria 9,999999999999998, e o erro se
acumularia em cada relatório mensal. Há teste cobrindo isso.

**O modelo não calcula nada.** Nenhuma soma, data ou percentual passa pelo LLM.
Ele decide *o que* registrar; o `fin.ts` decide *como*. Isso importa porque o
Hermes não coloca a data atual no prompt (ele instrui o agente a rodar `date`),
então um modelo tentando resolver "ontem" na própria cabeça erraria. Em vez
disso, `--date ontem` é resolvido pelo script, com o fuso de São Paulo.

**O caminho quente não custa um turno extra.** Registrar um gasto é 90% do uso,
então esse fluxo vive no `SOUL.md`, que é injetado em toda sessão. A skill guarda
a cauda longa e só é carregada quando necessário. Menos ida e volta, menos
requisição, menos chance de erro.

**Transferência não é despesa.** Mover dinheiro entre suas contas fica fora dos
totais — é assim que pagar a fatura do cartão não conta o gasto duas vezes.

**O `user_id` não tem valor padrão.** A identidade é lida do ambiente
(`HERMES_SESSION_USER_ID`), acompanha toda tabela de caixa, e cada helper do
`db.ts` recebe `userId` como parâmetro **obrigatório** — porque um padrão
silencioso é exatamente como uma pessoa acaba vendo o saldo da outra. É o que faz
os dois caixas nunca se misturarem por acidente. Não é o que impede uma pessoa de
ir buscar o caixa da outra de propósito: para isso, veja
[onde a separação para](#até-onde-essa-separação-vai-e-onde-ela-para).

Detalhes em [docs/architecture.md](docs/architecture.md).

## Antes de expor isso a mais alguém

O agente tem um toolset `terminal` e o `.env` está montado em `/opt/data/.env`
dentro do container. Quem consegue conversar com o bot consegue pedir a ele para
imprimir a chave da OpenRouter e o token do bot — e, como está descrito acima, o
caixa da outra pessoa. Isso é inerente a dar um shell a um agente, e é por isso que
`TELEGRAM_ALLOWED_USERS` é a única trava que conta.

Um item saiu dessa lista: com todo mundo cadastrado por convite e o
`TALLY_ACCESS_CODE` apagado do `.env`, não há código de acesso no ambiente para ele
imprimir. As outras credenciais continuam lá, e o resto do parágrafo continua
valendo inteiro.

Um ID a mais na allowlist não é "mais um usuário do bot": é mais uma pessoa com
acesso ao container, às credenciais e aos dois caixas. Não existe um nível "só
pode registrar gastos".

A lista completa do que isso implica, mais o que fazer a respeito, está na
[seção de segurança do deploy](docs/deploy.md#segurança).

## Documentação

- [docs/setup.md](docs/setup.md) — instalação passo a passo
- [docs/usage.md](docs/usage.md) — tudo que você pode dizer ao bot
- [docs/architecture.md](docs/architecture.md) — como as peças se encaixam
- [docs/deploy.md](docs/deploy.md) — subir num VPS para ficar 24/7, e segurança
- [docs/roadmap.md](docs/roadmap.md) — áudio, foto e outras evoluções

## Licença

[MIT](LICENSE) — use, modifique e redistribua, mantendo o aviso de copyright.

Se for reaproveitar o projeto, o `hermes/SOUL.md` tem nomes de pessoa escritos à
mão ("Geovane e sua namorada"); troque pelos seus.
