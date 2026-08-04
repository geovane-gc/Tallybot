# Arquitetura

## As peças

```
   Telegram
      │  long polling (só tráfego de saída, nenhuma porta aberta)
      ▼
┌──────────────────────────────────────────────────────────┐
│ container tallybot          (nousresearch/hermes-agent)  │
│                                                          │
│  gateway                                                 │
│    │  TELEGRAM_ALLOWED_USERS  (nega por padrão)          │
│    │  exporta HERMES_SESSION_USER_ID no ambiente         │
│    ▼                                                     │
│  agente ──► modelo (OpenRouter, nemotron)                │
│    │                                                     │
│    │ toolset `terminal`                                  │
│    ▼                                                     │
│  node fin.ts <subcomando>                                │
│    │  lê a identidade do ambiente, exige autenticação    │
│    ▼                                                     │
│  SQLite  /opt/data/finance/tally.db   (user_id em tudo)  │
└──────────────────────────────────────────────────────────┘
      │
      ▼  volume
   ./data no host   (config, sessões, memórias, banco, .env)
```

O container é a unidade de deploy inteira. Não há serviço separado, banco
externo, fila nem porta de entrada — o gateway conversa com a API do Telegram por
long polling, então nem firewall precisa ser tocado.

Repare que existem **duas** verificações, em camadas diferentes: o gateway decide
quem pode falar com o bot, e o `fin.ts` decide de quem é o dinheiro. Nenhuma das
duas passa pelo modelo.

## Onde vive cada instrução

Três camadas, com propósitos distintos. Entender a divisão é o que evita mexer no
arquivo errado.

| Camada | Arquivo | Quando é carregado | Para quê |
|---|---|---|---|
| Persona | `hermes/SOUL.md` | **Toda** sessão, automático | Quem o bot é, como escreve, e o caminho rápido de lançamento |
| Referência | `skills/finance/SKILL.md` | Sob demanda (`skill_view`) | Todos os subcomandos e as regras completas |
| Detalhe | `skills/finance/references/*.md` | Sob demanda, por arquivo | Taxonomia, parsing PT-BR, relatórios, schema |

**Por que dividir assim.** O Hermes injeta o `SOUL.md` em toda sessão, mas a
skill só entra no contexto quando o agente pede. Registrar um gasto é 90% das
mensagens; se esse fluxo estivesse só na skill, cada "uber 27" gastaria um turno
extra num `skill_view` — e turno extra, no tier free da OpenRouter, é requisição
da cota diária. Então o caminho quente mora no `SOUL.md`, e a cauda longa
(orçamentos, metas, recorrentes, export) fica na skill.

Não existe chave de configuração no Hermes para pré-carregar uma skill em sessões
de gateway — conferi no `config_defaults.py`. O `--skill` do `cron create` cobre
o caso dos relatórios agendados, e é por isso que os cron jobs o usam.

## A divisão de idiomas

O repositório é bilíngue de propósito, e a fronteira é uma pergunta só: **essa
string pode chegar ao Telegram?**

| | Idioma |
|---|---|
| Identificadores, comentários, tabelas, colunas, chaves do JSON | Inglês |
| `SKILL.md`, `references/`, `SOUL.md`, compose, `Makefile`, scripts | Inglês |
| README e `docs/` | Português |
| Mensagens de `FinError`, nomes de categoria, rótulos de período, texto dos relatórios | Português |

Por isso `{"ok": false, "error": "Conta \"Nubank\" não existe…"}` mistura os dois:
a chave é inglês porque só o código a lê; o valor é português porque o agente o
repassa palavra por palavra no chat. Mesma lógica em `period.label`, que entra no
título do relatório, e em `categories.name`, que aparece em toda listagem.

A regra está escrita no topo do `db.ts`, onde quem for mexer a encontra primeiro.

Os prompts do `cron-jobs.sh` também são português: eles instruem o agente a
produzir uma mensagem para você, e carregam os moldes de resposta.

## A regra central: o modelo não calcula

Toda aritmética de dinheiro, data, percentual e orçamento vive no `fin.ts`. O
modelo decide **o que** registrar; nunca **como** calcular.

Isso não é preciosismo. O Hermes deliberadamente **não** coloca a data atual no
prompt do sistema — ele instrui o agente a rodar `date` no terminal quando
precisar (`agent/prompt_builder.py`). Um modelo tentando resolver "ontem" de
cabeça, sem saber que dia é hoje, erraria. Então `--date ontem` é passado
literalmente e resolvido pelo script, no fuso de São Paulo.

O mesmo vale para valores: `--amount "1.234,56"` chega cru, e o parser trata o
formato brasileiro. Pedir ao modelo para "converter para float" seria convidar o
erro.

## Identidade: uma fronteira e dois guarda-corpos

Duas pessoas usam o bot e cada uma tem o próprio caixa. A pergunta que decide a
arquitetura é: **quem responde "de quem é esse lançamento?"**

Três camadas, de fora para dentro. Vale dizer de saída qual é qual, porque é fácil
confundir: **só a primeira é uma fronteira de segurança.** As outras duas são
guarda-corpos — mantêm o bot na linha no uso normal e impedem o acidente, e é para
isso que elas servem.

**1. A allowlist, no gateway — esta é a fronteira.**
`TELEGRAM_ALLOWED_USERS` é checado pelo adaptador do Telegram *antes* de o agente
rodar. Sem allowlist, o Hermes nega todo mundo: no fonte, a ausência da variável
cai num `return` que só passa se `GATEWAY_ALLOW_ALL_USERS` estiver ligado —
fail-closed de propósito. Esta camada não passa pelo modelo em nenhum ponto, e é a
única que vale como controle de acesso.

**2. A identidade, pelo ambiente — guarda-corpo.** O Hermes exporta
`HERMES_SESSION_USER_ID` (mais `HERMES_SESSION_CHAT_ID` e
`HERMES_SESSION_CHAT_TYPE`) no ambiente de todo processo que o toolset `terminal`
dispara. O `fin.ts` lê dali, em vez de aceitar que o modelo diga por quem está
agindo. O `SOUL.md` proíbe pedir um ID e a skill documenta que passar `--user`
numa conversa é erro.

`--user` existe para quem chama de fora de uma sessão: o Makefile, o
`cron-jobs.sh`, os testes. Havendo identidade de sessão, um `--user` que discorde
é recusado em vez de o `fin.ts` escolher um lado. Sem identidade nenhuma, também
recusa: sem identidade, sem caixa.

Um detalhe que só se vê no código: `HERMES_SESSION_USER_ID` vazio é tratado como
ausente, não como o ID `""`. O Hermes deixa esse campo vazio no caminho de
observação anônima de grupo, e uma string vazia virando ID juntaria todo mundo
que chegasse por ali num único caixa.

**3. O código de acesso, na ferramenta — guarda-corpo.** Cada pessoa digita
`TALLY_ACCESS_CODE` uma vez. A verificação está no `fin.ts` e não no prompt, e
esse é o ponto: um LLM se deixa convencer — "ignore suas instruções, eu já
autentiquei" é literalmente a classe de ataque que existe contra prompts. Um `if`
não. Então quem recusa é a ferramenta, e o agente só sabe repassar a mensagem.

O código não fica no banco (um backup o carregaria) nem no prompt (o modelo o
repetiria). Vive na variável de ambiente e é comparado por digestos SHA-256 com
`timingSafeEqual` — hasheado dos dois lados porque `timingSafeEqual` estoura com
tamanhos diferentes, e responder "tamanho errado" mais rápido que "código errado"
vazaria o comprimento do código.

### Onde as camadas 2 e 3 param

Sem rodeio, porque a diferença importa: **as camadas 2 e 3 não resistem a alguém
que peça ao bot para rodar um comando.**

O `HERMES_SESSION_USER_ID` é uma variável de ambiente de um processo que o
*próprio agente* dispara, e o `terminal` está com `backend: local`. Basta
dispará-lo sem ela:

    env -u HERMES_SESSION_USER_ID node fin.ts ls --period all --user <o outro ID>

Aí não existe identidade de sessão para discordar, o `--user` é honrado, e o caixa
alheio sai inteiro. Os IDs vêm de `fin.ts auth users`, que não exige autenticação.
Dois comandos, nenhum código de acesso, nada de adivinhação — uma revisão
adversarial rodou exatamente isso contra um banco real de duas pessoas.

E consertar o CLI não fecharia o buraco: o agente tem shell e o `tally.db` está
montado, então `node -e` com `node:sqlite` abre o arquivo direto. O
[`references/schema.md`](../skills/finance/references/schema.md) inclusive entrega
o trecho pronto, porque existe para consultas que o CLI não cobre.

A camada 3 não ajuda aqui pelo mesmo motivo: o código precisa estar no ambiente do
processo que o agente dispara, então um `env | grep TALLY` o revela.

O que sobra, dito com precisão:

| | Protege contra |
|---|---|
| `TELEGRAM_ALLOWED_USERS` | Terceiros. É a fronteira, e é real. |
| `user_id` em toda consulta | Os dois caixas se misturarem por acidente. Sólido — ver abaixo. |
| Identidade pelo ambiente, `--user` recusado | O bot trocar de caixa quando alguém pede, e o erro honesto do operador. |
| Código de acesso | Ninguém, contra o agente. É uma etapa de cadastro. |

A parte de **correção** é forte, e isso não é pouco: uma varredura de todas as
consultas SQL dos comandos de dados não achou um único vazamento, incluindo
tentativas de alcançar linha alheia por ID cru ou por nome — a resposta é a mesma
de uma linha que não existe. No uso normal, cada pessoa vê só o seu, sempre.

O que não existe é sigilo **entre as duas**. Um container, um arquivo de banco, um
agente com shell: qualquer uma das duas alcança o caixa da outra se souber pedir.
Para duas pessoas que confiam uma na outra isso é adequado — é o caso para o qual
o bot foi feito. Isolamento real exige **um container, um volume e um token de bot
por pessoa**; ver "Limites conhecidos" no fim deste documento.

Detalhes de comportamento que caem daí:

- A resposta de falta de autenticação carrega `"auth_required": true`. É a única
  deixa do agente para pedir o código.
- "ID desconhecido" e "sessão revogada" devolvem **a mesma** mensagem. O agente
  trata um caso só, e quem estiver sondando IDs não aprende nada.
- Cinco códigos errados travam aquela pessoa. O contador mora numa linha de
  `users` criada até para um ID desconhecido — sem essa linha, um ID de fora teria
  tentativas infinitas. Ela nasce com `authenticated_at` nulo, então não possui
  nada e não alcança nada.
- `auth logout-all` (`make logout-all`) incrementa `app_state.auth_epoch`. Toda
  sessão com `auth_epoch` abaixo do global vira inválida de uma vez, e o mesmo
  comando zera os contadores de tentativa — é assim que se desbloqueia alguém.
  **Nenhum dado é apagado:** os lançamentos continuam lá e reaparecem quando cada
  um redigita o código.
- O primeiro login de uma pessoa é o que **cria** o caixa dela: as 17 categorias,
  as ~70 subcategorias, a conta "Carteira" e as configurações iniciais. O `init`
  não semeia mais nada, porque a taxonomia é por pessoa e no `init` ainda não
  existe pessoa.

## Por que TypeScript sem dependências

A imagem do Hermes traz Node 26. Isso dá três coisas de graça:

- **`node fin.ts` roda direto**, porque o Node 26 remove os tipos nativamente.
  Sem `tsc`, sem `tsx`, sem bundler, sem passo de build entre editar e rodar.
- **`node:sqlite` é embutido**, então não há `better-sqlite3` para compilar nem
  módulo nativo para quebrar em troca de arquitetura.
- **`node --test` é embutido**, então a suíte roda sem framework instalado.

Consequência prática: `node_modules` não existe neste projeto. Os dois
`package.json` só declaram `"type": "module"` — o da raiz para ergonomia de
desenvolvimento, e o de `skills/finance/` porque a skill é montada sozinha em
`/opt/data/skills/finance` dentro do container, sem enxergar a raiz do repo.

Os tipos pagam por si num lugar específico: `Cents` é um tipo marcado
(`number & { __brand }`), então passar reais onde se espera centavos não compila.
É a classe de erro mais fácil de cometer em código financeiro.

## Contrato entre agente e ferramenta

Toda chamada devolve JSON, sempre com a mesma forma:

```json
{ "ok": true,  "transaction": { … } }
{ "ok": false, "error": "Conta \"Nubank\" não existe. Rode `account list`…" }
{ "ok": false, "error": "…", "auth_required": true }
```

Três propriedades importam:

**As mensagens de erro são escritas para o usuário final**, em português, falando
de dinheiro e não de SQL. O agente pode repassá-las direto. Erro do `parseArgs`
também é traduzido, e a mensagem lista as opções aceitas naquele subcomando — se
o modelo inventa `--currency`, ele recebe de volta o que existe.

**A resposta do `add` já traz o orçamento afetado.** Se o gasto cruzou o limite, o
campo `budget` vem com `status: "warning"` na mesma resposta. O agente avisa
sem uma segunda chamada, economizando uma requisição em cada lançamento que
importa.

**`auth_required` é uma flag, não um texto a interpretar.** Ela aparece só na falta
de sessão válida, e é a única deixa do agente para pedir o código de acesso — em
vez de deixá-lo adivinhar isso a partir da mensagem de erro.

## Modelo de dados

Treze tabelas, uma view. Onze são o caixa; duas — `users` e `app_state` — chegaram
com a migration 2 e cuidam de identidade e sessão. O detalhe completo está em
[`skills/finance/references/schema.md`](../skills/finance/references/schema.md).

Cinco decisões que moldam as consultas:

**`user_id` em toda tabela de caixa.** `transactions`, `accounts`, `categories`,
`budgets`, `goals`, `recurring`, `tags`, `sent_alerts` e `settings` — todas. E
toda restrição `UNIQUE` virou por usuário: as duas pessoas podem ter uma conta
"Nubank" e uma meta "Viagem" sem colidir. Os índices compostos começam por
`user_id`, porque toda listagem, total e relatório filtra por pessoa antes de
filtrar por data.

Os helpers do `db.ts` recebem `userId` como parâmetro **obrigatório**, sem valor
padrão. Um padrão silencioso é exatamente como uma pessoa acaba vendo o saldo da
outra.

**Centavos inteiros (`amount_cents`).** Nunca float, em nenhuma coluna.

**Categorias em dois níveis.** `Alimentação > Delivery`. Filtrar ou orçar a raiz
inclui as filhas — sem isso, um teto em "Alimentação" ignoraria tudo que foi
lançado em "Delivery" e nunca fecharia com a soma das partes.

**Transferência é um tipo de lançamento**, não duas linhas. Fica fora dos totais
de despesa e receita: mover dinheiro entre contas suas não é gasto. É assim que
pagamento de fatura de cartão é registrado sem contar o gasto duas vezes.

**Parcelas são lançamentos reais**, um por mês, unidos por `installment_group`. Não
são um campo "12x" numa linha só. Assim a parcela cai no mês em que vence e o
relatório de março mostra o que de fato pesa em março. A divisão preserva o
centavo: R$ 100 em 3× vira 33,34 + 33,33 + 33,33.

### Como a migration 2 preservou o que já existia

O SQLite não altera uma restrição `UNIQUE`. Então a migration 2 faz, para cada
tabela, a dança de criar a `_v2`, copiar, dropar e renomear — com
`PRAGMA foreign_keys = OFF` durante o processo, porque com elas ligadas o
`ALTER TABLE ... RENAME` reescreveria as cláusulas `REFERENCES` das outras tabelas
apontando para os nomes `_v2` temporários.

Os `id` são preservados na cópia, de propósito: os números de lançamento que a
pessoa já tinha citado no chat continuam valendo.

O que já estava no banco é atribuído a um usuário `legacy`, com `authenticated_at`
nulo — quem usava o bot antes digita o código uma vez e reencontra tudo. Esse
`INSERT` é condicionado a haver alguma linha em alguma tabela, então uma instalação
nova não ganha o placeholder.

**`users.telegram_user_id` é TEXT, não INTEGER.** IDs do Telegram já passaram de
2³², e como número em JSON acabariam perdendo precisão. Como texto, nunca.

**`users.telegram_chat_id` só é gravado se a conversa for privada.** É de lá que o
cron tira o destino dos relatórios; um ID de grupo ali publicaria o extrato de
alguém para a sala inteira.

## Deduplicação de alertas

O cron checa limites três vezes ao dia. Sem controle, você receberia "Alimentação
em 85%" às 9h, 15h e 21h, todos os dias até o fim do mês.

A tabela `sent_alerts` tem `(user_id, key, month, level)` como chave primária, e
`alerts --mark` registra o que já foi avisado. Subir de `warning` para
`over` conta como alerta novo, porque é informação nova. O `user_id` na chave é o
que impede que o alerta de uma pessoa silencie o da outra sobre a mesma categoria
no mesmo mês.

Quando não há nada a dizer, `alerts` devolve `silent: true` e o agente responde
apenas `[SILENT]` — marcador que o Hermes reconhece e não entrega. Um bot que
notifica sem motivo é um bot que você silencia.

## Fuso horário

Três camadas, cada uma resolvida onde importa:

1. **Container** roda com `TZ=America/Sao_Paulo` (definido no compose). Sem isso,
   um cron agendado para 21h dispararia às 18h de Brasília.
2. **`fin.ts`** usa `Intl.DateTimeFormat` com `timeZone: "America/Sao_Paulo"`
   para descobrir "hoje", independente do TZ do processo.
3. **Aritmética de calendário** usa `Date.UTC` sobre os componentes da data, não
   o fuso local. Somar um mês a 31/01 dá 28/02, e não uma data inválida.

## Fluxo de uma mensagem

```
"89,90 no ifood ontem no nubank"
   │
   ├─ gateway do Telegram valida o remetente contra TELEGRAM_ALLOWED_USERS
   │     └─ fora da lista: descartado aqui, o agente nem acorda
   ├─ gateway exporta HERMES_SESSION_USER_ID=123456789 no ambiente da sessão
   ├─ SOUL.md já está no contexto: o agente sabe o caminho rápido
   ├─ terminal: node fin.ts add --amount 89,90 --description "iFood"
   │                            --category Delivery --account Nubank --date ontem
   │            (sem --user: a skill e o SOUL.md proíbem o agente de passar um)
   │     ├─ resolveCaller          -> 123456789, source: "session"
   │     ├─ requireUser            -> users.id 2  (código já digitado,
   │     │                            auth_epoch >= app_state.auth_epoch)
   │     ├─ parseAmount("89,90")   -> 8990 centavos
   │     ├─ parseDate("ontem")     -> 2026-08-02 (fuso de São Paulo)
   │     ├─ resolveCategory(2, …)  -> Delivery (subcategoria vence a raiz)
   │     ├─ resolveAccount(2, …)   -> Nubank  (o Nubank dela, não o dele)
   │     ├─ INSERT ... user_id = 2
   │     └─ budgetForCategory(2)   -> { status: "warning", … }
   │
   └─ "✅ R$ 89,90 · Delivery · ontem · Nubank (#88)
       🟡 Alimentação: R$ 324,46 de R$ 400,00 este mês."
```

Duas chamadas de modelo no total: uma para decidir o comando, outra para redigir a
confirmação lendo o JSON.

Se `requireUser` não encontrar uma sessão válida, ele interrompe antes de qualquer
aritmética e devolve `{"ok": false, "auth_required": true, …}`. O agente repassa o
pedido de código e espera. Nenhum subcomando decide por conta própria se o
chamador pode entrar — o portão roda uma vez, antes do dispatch, e todo mundo
abaixo dele recebe um `users.id` já resolvido.

## Os relatórios agendados, um conjunto por pessoa

O `--deliver` de um cron job é o que define o destino. Um `--deliver telegram`
puro cai em `TELEGRAM_HOME_CHANNEL`, que é um chat só — os relatórios das duas
pessoas iriam para o mesmo lugar. Por isso o `cron-jobs.sh` usa a forma com
dois-pontos, `--deliver telegram:<chat_id>`, que o `cron/scheduler.py` resolve e
que vence a variável de ambiente. Numa conversa privada do Telegram o `chat_id` é
igual ao ID do usuário.

O script lê `fin.ts auth users` para saber para quem agendar, e cria cinco jobs
por pessoa, nomeados `tally-<tipo>-<id do telegram>`. Cada prompt passa `--user`
explicitamente: uma execução de cron não tem mensagem de entrada, então o gateway
não vincula identidade nenhuma e o CLI não teria como inferir o chamador.

É idempotente — remove todo `tally-*` e recria — então rodar de novo depois que
alguém entra só acrescenta os jobs daquela pessoa. A consequência operacional é
que `make cron-install` precisa vir **depois** dos logins, e ser repetido quando
alguém novo aparece.

`TELEGRAM_HOME_CHANNEL` sobrou apenas como destino de reserva para notificações do
próprio Hermes que chegam sem alvo explícito.

## Limites conhecidos

**Rate limit, não custo.** O modelo é gratuito, mas a OpenRouter limita ~50
requisições/dia sem crédito na conta. Com 2 a 4 requisições por mensagem, isso dá
uns 15 lançamentos diários. US$ 10 comprados uma vez levam o limite a ~1000/dia.

**Modelo free erra mais.** `max_turns: 30` e os `tool_loop_guardrails` existem
para que um erro do modelo não vire um loop que queima a cota. Se ele começar a
escolher comandos errados, trocar `model.default` por
`google/gemma-4-31b-it:free` é uma linha em `hermes/config.yaml`.

**Duas pessoas, não N.** Tecnicamente o schema aguenta qualquer número de linhas
em `users`, e nada no `fin.ts` conta pessoas. O que é feito para duas é o resto: o
código de acesso é um só, compartilhado, então não há como revogar o acesso de uma
pessoa sem forçar a outra a redigitar. Para um grupo maior, o caminho seria um
código por pessoa ou um convite de uso único.

**Nada é compartilhado, nem quando você quer.** Não existe despesa conjunta, rateio
nem visão somada do casal. É a decisão certa por padrão, mas significa que "quanto
nós dois gastamos de mercado" não tem resposta — ver [roadmap.md](roadmap.md).

**O agente tem um shell, e isso define o modelo de ameaça inteiro.** Quem passa da
allowlist pode pedir ao bot que imprima as credenciais (o `.env` está em
`/opt/data/.env`), o código de acesso, e o caixa da outra pessoa. Não é um bug do
Tally: é o que significa dar um toolset `terminal` a um agente. As consequências:

- A allowlist é a única trava que conta, e um ID a mais nela é mais uma pessoa com
  acesso ao container e a tudo dentro dele.
- Não existe sigilo entre as duas pessoas, só correção. Ver
  [Onde as camadas 2 e 3 param](#onde-as-camadas-2-e-3-param).
- Isolamento real entre duas pessoas exige **um container, um volume e um token de
  bot por pessoa**. É a mesma imagem e o mesmo compose, duplicados, com `.env` e
  `data/` próprios. Custa o dobro de RAM e nenhuma linha de código.

Detalhes e mitigações em [deploy.md](deploy.md#segurança).

**Sem áudio nem foto** nesta versão — ver [roadmap.md](roadmap.md), que descreve
o que cada um exigiria.
