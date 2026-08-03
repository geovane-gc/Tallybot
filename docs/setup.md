# Instalação

Do zero ao bot respondendo: uns 15 minutos, a maior parte esperando o download
da imagem.

## Pré-requisitos

- Docker com Docker Compose v2 (`docker compose version`)
- Node.js 24+ no host (só para o bootstrap e os testes; o container traz o seu)
- Uma conta no Telegram

## 1. Criar o bot no Telegram

Abra uma conversa com [@BotFather](https://t.me/BotFather):

```
você:      /newbot
BotFather: Alright, a new bot. How are we going to call it?
você:      Meu Controle Financeiro          ← nome de exibição, livre
BotFather: Good. Now let's choose a username for your bot.
você:      geovane_financas_bot             ← precisa terminar em "bot" e ser único
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

## 2. Descobrir seu ID numérico

Mande `/start` para o [@userinfobot](https://t.me/userinfobot). Ele responde na
hora com algo assim:

```
Id: 123456789
First: Geovane
```

Esse `Id` é o `TELEGRAM_ALLOWED_USERS`. É a trava de segurança: só os IDs
listados conseguem conversar com o bot. Sem allowlist, o Hermes recusa todo
mundo — e é o comportamento correto, já que esse bot fala do seu dinheiro.

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

## 4. Configurar

```bash
cd financas-bot
cp .env.example .env
```

Abra o `.env` e preencha:

```ini
OPENROUTER_API_KEY=sk-or-v1-...
TELEGRAM_BOT_TOKEN=7123456789:AAF-...
TELEGRAM_ALLOWED_USERS=123456789
TELEGRAM_HOME_CHANNEL=123456789
```

`TELEGRAM_HOME_CHANNEL` é onde caem os relatórios agendados. Para conversa
privada, é o mesmo número do seu ID.

`HERMES_UID` e `HERMES_GID` podem ficar vazios — o `make up` detecta e preenche
com o seu usuário, para que os arquivos em `data/` continuem editáveis por você.

## 5. Subir

```bash
make up
```

O que acontece:

1. Valida que as variáveis obrigatórias estão preenchidas (e para com uma
   mensagem clara se faltar alguma).
2. Escreve seu UID/GID no `.env`.
3. Cria `data/` e copia `hermes/config.yaml` e `hermes/SOUL.md` para lá.
4. Cria e migra o banco SQLite.
5. Baixa a imagem oficial do Hermes (~4 GB na primeira vez) e sobe o container.

Acompanhe:

```bash
make logs
```

Você quer ver:

```
[Telegram] Connecting to Telegram (attempt 1/8)…
✓ telegram connected
```

## 6. Agendar os relatórios

```bash
make cron-install
```

Cria cinco rotinas:

| Job | Quando | O que faz |
|---|---|---|
| `financas-recorrentes` | 06:00 todo dia | Lança as despesas fixas vencidas |
| `financas-alertas` | 09h, 15h e 21h | Avisa se algum limite apertou |
| `financas-diario` | 21:00 todo dia | Resumo do dia (silencioso se não houve gasto) |
| `financas-semanal` | Domingo 20:00 | Fechamento da semana |
| `financas-mensal` | Dia 1º, 09:00 | Fechamento do mês + planilha CSV |

Os horários são de Brasília: o container roda com `TZ=America/Sao_Paulo`.

Conferir: `make cron-list`. Testar um agora, sem esperar:

```bash
docker compose exec hermes hermes cron run financas-diario
```

## 7. Primeira conversa

No Telegram, mande para o seu bot:

```
oi
```

Ele deve se apresentar em português. Depois:

```
uber 27
```

Você deve receber a confirmação com o número do lançamento. Confira que gravou
de verdade, direto no banco, sem passar pelo modelo:

```bash
make saldo
make resumo
```

## Configuração inicial recomendada

Vale fazer uma vez, conversando com o bot:

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

## Se algo der errado

**`Faltam variáveis no .env`** — o bootstrap achou um campo vazio. Preencha e
rode de novo.

**`The token ... was rejected by the server`** — token errado ou revogado. Copie
de novo do BotFather.

**O bot não responde nada.** Seu ID está em `TELEGRAM_ALLOWED_USERS`? Sem estar
na lista, o gateway ignora a mensagem em silêncio, de propósito. Confirme com
`make logs`.

**`429` ou "rate limit" nos logs** — bateu o limite diário da OpenRouter. Espere
o dia virar (o reset é em UTC) ou compre os US$ 10 de crédito.

**O bot responde mas não registra nada.** Verifique se a ferramenta está
acessível:

```bash
docker compose exec hermes node /opt/data/skills/financas/scripts/fin.ts saldo
```

Se isso funcionar e o bot ainda não registrar, o problema é o modelo não chamando
a ferramenta. Rode `make doctor` e confira `make logs` para ver o que ele tentou.

**Erro de permissão em `data/`** — `HERMES_UID`/`HERMES_GID` não batem com o seu
usuário. Apague as duas linhas do `.env`, deixe vazias, e rode `make up` de novo.

Diagnóstico geral: `make doctor`.
