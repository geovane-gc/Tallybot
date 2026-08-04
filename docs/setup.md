# Instalação

Do zero ao bot respondendo: uns 15 minutos, a maior parte esperando o download
da imagem.

O bot atende **duas pessoas**, com as finanças separadas. Isso muda dois pontos
da instalação: os dois IDs entram na allowlist, e cada uma digita um código de
acesso uma vez — um **convite** dela (o caminho recomendado) ou um código
compartilhado (o caminho simples). A ordem no fim também muda — os relatórios
agendados só podem ser criados depois que as duas autenticaram.

## Pré-requisitos

- Docker com Docker Compose v2 (`docker compose version`)
- Node.js 24+ no host (só para o bootstrap e os testes; o container traz o seu)
- Uma conta no Telegram para cada pessoa

## 1. Criar o bot no Telegram

Abra uma conversa com [@BotFather](https://t.me/BotFather):

```
você:      /newbot
BotFather: Alright, a new bot. How are we going to call it?
você:      Meu Controle Financeiro          ← nome de exibição, livre
BotFather: Good. Now let's choose a username for your bot.
você:      meu_tally_bot                 ← precisa terminar em "bot" e ser único
BotFather: Done! Use this token to access the HTTP API:
           7123456789:AAF-abcdefgh...       ← este é o TELEGRAM_BOT_TOKEN
```

Guarde o token. Quem tiver ele controla o bot; se vazar, mande `/revoke` para o
BotFather.

Ainda no BotFather, vale ajustar (opcional):

```
/setdescription   → "Seu controle financeiro pessoal."
/setcommands      → deixe vazio: este bot entende texto livre, não comandos
```

## 2. Descobrir os IDs numéricos das duas pessoas

Cada uma manda `/start` para o [@userinfobot](https://t.me/userinfobot). Ele
responde na hora com algo assim:

```
Id: 123456789
First: Geovane
```

Os dois `Id` vão em `TELEGRAM_ALLOWED_USERS`, separados por vírgula:

```ini
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

**Essa é a trava de segurança de verdade.** O Hermes valida o remetente no
gateway, antes de o modelo rodar, então quem não está na lista nunca chega ao
agente. Sem allowlist ele nega todo mundo — o padrão é negar, e é o
comportamento correto para um bot que fala de dinheiro.

Um ID a mais na lista é uma pessoa a mais com acesso ao container. Leia
[Segurança](#segurança) antes de acrescentar alguém.

## 3. Chave da OpenRouter

1. Crie a conta em [openrouter.ai](https://openrouter.ai).
2. Gere a chave em [openrouter.ai/keys](https://openrouter.ai/keys). Ela começa
   com `sk-or-v1-`.

**Sobre o limite do tier gratuito.** O modelo usado
(`nvidia/nemotron-3-ultra-550b-a55b:free`) não cobra por token, mas a OpenRouter
limita a quantidade de requisições por dia:

| Crédito na conta | Requisições/dia |
|---|---|
| Nenhum | ~50 |
| US$ 10 comprados uma vez | ~1000 |

Cada mensagem sua vira de 2 a 4 requisições, porque o agente chama a ferramenta,
lê o resultado e às vezes consulta o orçamento. Com 50/dia você registra uns 15
gastos e acaba a cota. Os US$ 10 não são consumidos pelos modelos `:free` — o
crédito só serve para destravar o limite. É o único gasto que vale a pena.

## 4. Escolher como as pessoas entram

Cada pessoa digita um código uma vez, na primeira mensagem ao bot. Enquanto ela não
digitar, o `fin.ts` recusa qualquer comando que envolva valor. Existem dois modos, e
eles funcionam ao mesmo tempo:

| | Convite por pessoa (recomendado) | Código compartilhado (simples) |
|---|---|---|
| Como nasce | `make invite LABEL="Namorada"` | `TALLY_ACCESS_CODE` no `.env` |
| Serve para | uma pessoa, uma vez | todo mundo, sempre |
| Validade | expira (48h por padrão) | nunca |
| Onde fica guardado | só o SHA-256, no banco | na variável de ambiente, para sempre |
| Revogar uma pessoa | `make revoke TG_USER=<id>` | não dá sem mexer nas duas |

**Para uma instalação nova, use convite.** O convite resolve três problemas do
código único: dá para cortar o acesso de uma pessoa sem incomodar a outra, ele
morre depois de ser usado (quem sabe o código não cadastra um segundo Telegram
depois), e ele não fica no ambiente — o agente tem shell, e um `env | grep TALLY`
mostra o que estiver lá.

Mas o código compartilhado continua funcionando e não vai sair: se você já tem uma
instalação rodando com `TALLY_ACCESS_CODE`, não precisa mudar nada. Para gerar um:

```bash
openssl rand -base64 24
```

Duas coisas valem para os dois modos:

**Combine pessoalmente.** Falado, não escrito. Mandar o código pelo próprio
Telegram (ou por qualquer chat) coloca o segredo no mesmo lugar que ele protege. Por
isso o convite é gerado sem `0`/`O` e sem `1`/`I`/`L` — ele nasce para ser ditado em
voz alta (`7K2M-QX9P-4TVB`).

**Não é uma trava, é um cadastro.** A allowlist é a trava. O código serve para
amarrar cada lançamento a uma pessoa e dar uma etapa explícita de entrada. Ele não
protege de quem está fora da allowlist (essa pessoa nem chega aqui) e **não protege
uma das duas pessoas da outra** — convite nenhum muda isso, porque o agente tem
shell e o banco é um arquivo que ele abre. Convite melhora cadastro e revogação,
não isolamento. Ver [Segurança](#segurança) mais abaixo.

## 5. Configurar

```bash
cd tallybot
cp .env.example .env
```

Abra o `.env` e preencha:

```ini
OPENROUTER_API_KEY=sk-or-v1-...
TELEGRAM_BOT_TOKEN=7123456789:AAF-...
TELEGRAM_ALLOWED_USERS=123456789,987654321
TALLY_ACCESS_CODE=<o que o openssl gerou; pode ficar vazio se você for de convite>
TELEGRAM_HOME_CHANNEL=123456789
```

`TALLY_ACCESS_CODE` é **opcional**. Deixando vazio, o `make up` avisa que a
instalação roda só com convite e segue em frente — ele só reclama quando ninguém
consegue entrar de jeito nenhum (sem código, sem convite e sem ninguém
cadastrado).

`TELEGRAM_HOME_CHANNEL` **não** é mais onde caem os relatórios agendados: cada
pessoa recebe os dela na própria conversa privada. Ele hoje é só o destino de
reserva para notificações do próprio Hermes que chegam sem alvo explícito.
Coloque o seu ID ali para que uma mensagem perdida ainda encontre alguém.

`HERMES_UID` e `HERMES_GID` podem ficar vazios — o `make up` detecta e preenche
com o seu usuário, para que os arquivos em `data/` continuem editáveis por você.

O bootstrap deixa o `.env` em `chmod 600` a cada execução, e o `.gitignore` cobre
`.env*` (fora o `.env.example`), exports, `*.csv` e arquivos de banco.

## 6. Subir

```bash
make up
```

O que acontece:

1. Valida que as variáveis obrigatórias estão preenchidas (a chave da OpenRouter, o
   token do bot e a allowlist) e para com uma mensagem clara se faltar alguma.
   `TALLY_ACCESS_CODE` não está nessa lista de propósito — ver o passo 4.
2. Escreve seu UID/GID no `.env` e garante `chmod 600` nele.
3. Cria `data/` e copia `hermes/config.yaml`, `hermes/SOUL.md` e o `.env` para lá.
4. Cria e migra o banco SQLite (hoje na versão 4 do schema).
5. Baixa a imagem oficial do Hermes (~4 GB na primeira vez) e sobe o container.

Nada de categoria ou conta é criado aqui: a taxonomia é por pessoa, então ela
nasce no primeiro login de cada uma.

Acompanhe:

```bash
make logs
```

Você quer ver:

```
[Telegram] Connecting to Telegram (attempt 1/8)…
✓ telegram connected
```

## 7. Primeira conversa: as duas pessoas autenticam

Se você escolheu convite, gere um para cada pessoa **antes** — um comando por
pessoa, no terminal do servidor:

```bash
make invite LABEL="Geovane"
make invite LABEL="Namorada" HOURS=24
```

A saída traz o código **uma única vez**:

```json
{
  "ok": true,
  "code": "7K2M-QX9P-4TVB",
  "invite": { "id": 2, "label": "Namorada", "status": "pending",
              "expires_at": "2026-08-05T21:14:03-03:00" },
  "message": "🎟️ Convite de Namorada: 7K2M-QX9P-4TVB — vale 24h e serve uma vez só…"
}
```

**Só o hash vai para o banco**, então esse código não aparece de novo em lugar
nenhum: nem em `make invites`, nem num backup, nem se você pedir de novo. Perdeu?
Gera outro e revoga o antigo. Dite em voz alta, na frente da pessoa — ele foi
desenhado para isso (sem `0`/`O`, sem `1`/`I`/`L`).

`make invites` mostra o estado de todos, sem nunca mostrar código:

```bash
make invites
# id 1  Geovane   redeemed  por 123456789
# id 2  Namorada  pending   expira 05/08 21:14
```

No Telegram, cada uma manda para o bot:

```
oi
```

Ele pede o código:

```
🔒 Antes de falar de dinheiro eu preciso confirmar quem é você.
Me manda o código de acesso.
```

A mensagem seguinte é o código, digitado direto no chat — o convite dela, ou o
código compartilhado, o bot trata igual. Pode digitar em minúscula, com espaço no
lugar do traço ou sem separador nenhum: `7k2m qx9p 4tvb` funciona. Na resposta
certa:

```
✅ Tudo certo, agora é só me contar seus gastos.
```

Se o código não servir, a resposta é sempre a mesma — `Código incorreto.` — seja
porque estava errado, porque o convite expirou, porque já foi usado ou porque você
revogou. É de propósito: quem estiver testando códigos não aprende nada. E cinco
erros seguidos travam aquela pessoa (ver [Se algo der errado](#se-algo-der-errado)).

**O bot não cria convite.** `auth invite` é comando de operador e ele recusa dentro
de uma conversa; se alguém pedir para o bot "adicionar uma pessoa", ele responde que
só você faz isso, pelo terminal. Isso é essencial: um bot que pode convidar é um bot
que convida quem pedir.

Nesse momento o bot cria, para aquela pessoa, as 17 categorias, as ~70
subcategorias, a conta padrão "Carteira" e as configurações iniciais. É o
primeiro login que constrói o caixa.

Depois, um teste real:

```
uber 27
```

Você deve receber a confirmação com o número do lançamento.

Confirme quem ficou cadastrado:

```bash
make users
```

Sai um JSON com `telegram_user_id`, `display_name` e se a sessão está válida. É
de lá que vêm os IDs que os comandos do host pedem:

```bash
make balance TG_USER=123456789
make summary TG_USER=123456789
```

Isso lê o banco direto, sem gastar requisição do modelo. `TG_USER` se chama assim
e não `USER` porque o `make` importa o ambiente do shell — `USER` já tem o seu
nome de login, e o comando pediria o caixa de alguém que não existe sem dizer o
motivo.

### Apague o `TALLY_ACCESS_CODE` — é o ponto de tudo isso

Com as duas pessoas cadastradas (confirme no `make users`: `authenticated: true`
para as duas), apague a linha do `.env`:

```ini
TALLY_ACCESS_CODE=
```

```bash
make restart
```

**Aí não sobra segredo permanente em lugar nenhum.** O convite já foi consumido e
nunca esteve em texto claro no banco; o código compartilhado não existe mais no
ambiente. Um `env | grep TALLY` dentro do container passa a não mostrar nada — e
isso importa porque o agente tem shell e pode rodar exatamente esse comando. Era
esse o achado que o convite resolve.

O que continua funcionando depois de apagar: tudo. Quem já está cadastrado segue
cadastrado (a sessão está no banco, não na variável). Quem entrar depois entra por
convite. O `make up` não reclama da variável vazia.

E o que muda de verdade: só depois de apagar é que `make revoke` significa alguma
coisa. Com o código compartilhado no ambiente, a pessoa revogada volta digitando
ele — o próprio comando avisa isso na resposta.

## 8. Agendar os relatórios

**Só depois que as duas pessoas autenticaram.** O `cron-install` lê quem está
cadastrado e cria um conjunto de cinco jobs **por pessoa**; rodando antes, ele
avisa que não há ninguém para quem mandar relatório e sai.

```bash
make cron-install
```

Cinco rotinas para cada uma, com o ID do Telegram no nome:

| Job | Quando | O que faz |
|---|---|---|
| `tally-recurring-<id>` | 06:00 todo dia | Lança as despesas fixas vencidas |
| `tally-alerts-<id>` | 09h, 15h e 21h | Avisa se algum limite apertou |
| `tally-daily-<id>` | 21:00 todo dia | Resumo do dia (silencioso se não houve gasto) |
| `tally-weekly-<id>` | Domingo 20:00 | Fechamento da semana |
| `tally-monthly-<id>` | Dia 1º, 09:00 | Fechamento do mês + planilha CSV |

Cada job entrega em `telegram:<chat_id>`, que numa conversa privada é o mesmo
número do ID da pessoa. Ou seja: o relatório de cada um vai para o chat de cada
um, e não para um canal comum.

Os horários são de Brasília: o container roda com `TZ=America/Sao_Paulo`.

**Rode de novo sempre que alguém novo entrar.** O script é idempotente: apaga
todos os jobs `tally-*` e recria, então re-executar depois do segundo login
simplesmente acrescenta os jobs da segunda pessoa.

Conferir: `make cron-list`. Testar um agora, sem esperar:

```bash
docker compose exec hermes hermes cron run tally-daily-123456789
```

## Configuração inicial recomendada

Vale fazer uma vez, conversando com o bot. Cada pessoa faz a sua — as contas e os
limites de uma não existem para a outra:

```
cadastra meu cartão do nubank, vencimento dia 10, limite 5 mil
cadastra minha conta do itaú
usa o itaú como conta padrão
meu aluguel é 1500 todo dia 5
netflix 44,90 todo dia 20
limite de 800 pra alimentação
não quero gastar mais de 5 mil por mês
```

Daí em diante é só lançar os gastos.

## Segurança

O resumo curto, porque a maioria das pessoas não passa deste arquivo. A versão
completa está em [deploy.md](deploy.md#segurança) — leia antes de deixar o bot no
ar para alguém além de você.

**A allowlist protege muito mais do que os números.** O agente tem o toolset
`terminal` e o `.env` está montado em `/opt/data/.env` dentro do container. Quem
consegue conversar com o bot consegue pedir a ele para imprimir a chave da
OpenRouter e o token do bot. Isso é inerente a dar um shell a um agente; código de
acesso nenhum impede, porque o shell existe antes dele. Portanto:
`TELEGRAM_ALLOWED_USERS` só com os IDs de quem você confia nesse nível, e nunca
`GATEWAY_ALLOW_ALL_USERS`.

O que o convite tira dessa lista é um item: com `TALLY_ACCESS_CODE` apagado, não há
código de acesso no ambiente para o agente imprimir. As outras credenciais
continuam lá.

**As duas pessoas não estão isoladas uma da outra.** Os caixas não se misturam por
acidente — isso é sólido, e é uma garantia de correção. Mas qualquer uma das duas
consegue recuperar o caixa da outra pedindo ao bot para rodar um comando: é um
container, um arquivo de banco e um agente com shell. As checagens de identidade
dentro do `fin.ts` são guarda-corpos, não uma parede. **Convite não muda isso** —
ele melhora cadastro e revogação, não isolamento. Para um casal que confia um no
outro isso é adequado; se você precisa de isolamento real, é
[uma instância por pessoa](deploy.md#as-duas-pessoas-não-estão-isoladas-uma-da-outra).

**A skill é montada read-only** (`:ro` no compose), e é o padrão certo: sem isso o
agente pode reescrever o código que roda na próxima mensagem, incluindo as próprias
checagens. Remover o `:ro` é uma escolha consciente — em troca, melhorias que o
agente faz na skill aparecem como diff no git para você revisar.

**O dashboard mostra as chaves de API na tela.** O compose só o liga se
`HERMES_DASHBOARD` pedir, e mesmo aí ele escuta apenas em `127.0.0.1`. Atenção:
o `.env.example` ainda vem com `HERMES_DASHBOARD=1`, então uma instalação nova
sobe com ele ligado — troque para `0` se não for usar.

**Se uma pessoa precisar sair:** `make revoke TG_USER=<id>`. Só ela perde o acesso,
a outra não sente nada, e **nenhum dado é apagado** — o caixa dela continua inteiro
e reaparece se ela voltar com um convite novo. Para valer de verdade, o
`TALLY_ACCESS_CODE` precisa estar apagado do `.env`; senão ela volta digitando ele
(o próprio comando te avisa). Rode `make cron-install` depois: ele recria os jobs a
partir de quem está com sessão válida, e assim os relatórios agendados daquela
pessoa param de ser disparados.

**Se o código compartilhado vazar, ou você quiser zerar tudo:** `make logout-all`.
Todo mundo digita o código de novo, e também não apaga nada. É o botão de pânico;
`make revoke` é o bisturi.

## Se algo der errado

**`Missing variables in .env`** — o bootstrap achou um campo obrigatório vazio
(chave da OpenRouter, token do bot ou allowlist). Preencha e rode de novo.
`TALLY_ACCESS_CODE` não entra aí: vazio é permitido, e o bootstrap só para se
ninguém puder entrar — sem código, sem convite e sem ninguém cadastrado. A saída
dele diz as duas opções.

**`The token ... was rejected by the server`** — token errado ou revogado. Copie
de novo do BotFather.

**O bot não responde nada.** O ID daquela pessoa está em
`TELEGRAM_ALLOWED_USERS`? Sem estar na lista, o gateway ignora a mensagem em
silêncio, de propósito. Confirme com `make logs`.

**O bot pede o código de acesso de novo, do nada.** Alguém rodou `make logout-all`,
ou você revogou aquela pessoa com `make revoke`. No primeiro caso basta digitar o
código outra vez; no segundo ela precisa de um convite novo. Em nenhum dos dois
algum lançamento foi perdido.

**"Código incorreto" e a pessoa jura que digitou certo.** A mensagem é a mesma para
código errado, convite expirado, convite já usado e convite revogado — de propósito,
para não confirmar a quem está testando que um código existiu. Confira o estado em
`make invites`: se aparecer `expired` ou `revoked`, gere outro
(`make invite LABEL="..."`). Maiúscula/minúscula e traço não importam.

**"Bloqueei as tentativas depois de 5 códigos errados".** Cinco códigos errados
seguidos travam aquela pessoa, e ela fica travada até você liberar:

```bash
make users                                    # confirme o id
node skills/finance/scripts/fin.ts \
    --db data/finance/tally.db auth unlock --user 123456789
```

`auth unlock` é o único comando que libera — e ele zera tanto o contador daquela
pessoa quanto o contador global. `make logout-all` **não** libera (já liberou, um
dia; como ele não exige autenticação nenhuma, isso fazia do bloqueio um enfeite).

**"O acesso ainda não foi configurado no servidor".** Não há `TALLY_ACCESS_CODE` no
ambiente **e** nenhum convite foi gerado — ou seja, ninguém consegue entrar. Gere um
convite (`make invite LABEL="..."`) ou preencha a variável no `.env` e rode
`make restart`. Se já existe convite, essa mensagem não aparece: um código que não
casa com nada é só `Código incorreto.`

**`429` ou "rate limit" nos logs** — bateu o limite diário da OpenRouter. Espere
o dia virar (o reset é em UTC) ou compre os US$ 10 de crédito.

**O bot responde mas não registra nada.** Verifique se a ferramenta está
acessível. Fora de uma sessão do gateway não há identidade nenhuma, então aqui o
`--user` é obrigatório:

```bash
docker compose exec hermes node /opt/data/skills/finance/scripts/fin.ts \
    balance --user 123456789
```

Se isso funcionar e o bot ainda não registrar, o problema é o modelo não chamando
a ferramenta. Rode `make doctor` e confira `make logs` para ver o que ele tentou.

**`make cron-install` diz que não há usuário autenticado.** É exatamente isso: as
pessoas precisam mandar mensagem ao bot e digitar o código antes. Volte ao
[passo 7](#7-primeira-conversa-as-duas-pessoas-autenticam).

**Erro de permissão em `data/`** — `HERMES_UID`/`HERMES_GID` não batem com o seu
usuário. Apague as duas linhas do `.env`, deixe vazias, e rode `make up` de novo.

Diagnóstico geral: `make doctor`.
