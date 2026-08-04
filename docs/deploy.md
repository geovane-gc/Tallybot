# Deploy num servidor

Rodando no seu Mac, o bot fica offline quando a máquina dorme. Para ele estar de
pé quando você manda mensagem às 23h do sábado, precisa de um servidor.

## O que serve

O bot é leve: sem browser tools, o container fica em torno de 500 MB de RAM.

| | Mínimo | Confortável |
|---|---|---|
| RAM | 1 GB | 2 GB |
| CPU | 1 core | 2 cores |
| Disco | 10 GB | 20 GB (a imagem tem ~4 GB) |

Qualquer VPS de entrada dá conta: Hetzner CX22, DigitalOcean 1 GB, Oracle Cloud
Free Tier, uma Raspberry Pi na sua casa. Como o Telegram é acessado por long
polling, **nenhuma porta precisa ser aberta** e o servidor pode ficar atrás de NAT
sem IP público.

## VPS com Docker

No servidor, com Docker instalado:

```bash
git clone git@github.com:geovane-gc/tallybot.git
# sem chave SSH no servidor, ou sem acesso de escrita ao repo:
# git clone https://github.com/geovane-gc/tallybot.git
cd tallybot
cp .env.example .env
$EDITOR .env          # as mesmas variáveis do setup local
make up
```

Aí você gera um convite por pessoa (`make invite LABEL="Namorada"`, que imprime o
código uma única vez), as duas mandam mensagem ao bot e digitam o dela. **Só
depois:**

```bash
make cron-install
```

O `cron-install` cria um conjunto de cinco jobs por pessoa autenticada, cada um
entregando na conversa privada dela (`--deliver telegram:<chat_id>`). Rodando
antes dos logins, ele avisa que não há para quem mandar e sai sem criar nada.
Rode outra vez sempre que alguém novo entrar — ele apaga todo job `tally-*` e
recria, então repetir é seguro.

Fora isso, é o mesmo fluxo do ambiente local — o compose não tem nada específico
de macOS.

**Não rode as duas instâncias ao mesmo tempo.** A documentação do Hermes é
explícita: dois gateways contra o mesmo diretório de dados corrompem sessões e
memórias. E dois bots com o mesmo token brigam pelo long polling. Antes de subir
no servidor, `make down` no Mac.

## Levando seus dados

Se você já usou o bot localmente e quer manter o histórico:

```bash
# no Mac
make backup
scp backups/tally-*.db.gz usuario@servidor:~/

# no servidor
mkdir -p ~/tallybot/data/finance
gunzip -c ~/tally-2026*.db.gz > ~/tallybot/data/finance/tally.db
```

Só o banco precisa viajar. Sessões e memórias do agente podem começar do zero — a
carteira é o que importa.

Se esse banco é de antes do suporte a duas pessoas (schema versão 1), o `make up`
aplica a migration 2 sozinho, no boot. Tudo que já estava lá é atribuído a um
usuário placeholder — `telegram_user_id = 'legacy'` — e os `id` de lançamento são
preservados, então os números que você já tinha citado no chat continuam valendo.
Nada é apagado.

**Mas esse caixa não vem para você sozinho.** Quando você autentica pelo Telegram,
o `fin.ts` cria uma linha nova com o seu ID numérico, e o histórico continua
pendurado no `legacy`. Para adotá-lo, aponte o placeholder para o seu ID **antes**
do primeiro login, direto no banco:

```bash
sqlite3 data/finance/tally.db \
  "UPDATE users SET telegram_user_id = '123456789' WHERE telegram_user_id = 'legacy';"
```

Depois é só mandar a primeira mensagem e digitar o código: o login reconhece a
linha existente e reencontra tudo. (Se você já autenticou antes de fazer isso,
apague primeiro a linha vazia criada com o seu ID — ela não tem lançamento
nenhum.)

## Iniciar no boot

O `restart: unless-stopped` do compose religa o container se ele cair, mas não se
o servidor reiniciar sem o Docker subir sozinho. Garanta:

```bash
sudo systemctl enable docker
```

Se preferir amarrar o compose ao boot explicitamente:

```ini
# /etc/systemd/system/tallybot.service
[Unit]
Description=Bot financeiro no Telegram
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/SEU_USUARIO/tallybot
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=SEU_USUARIO

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tallybot
```

## Backup automático

O banco cabe em kilobytes, então backup diário é barato. No crontab do servidor:

```cron
0 3 * * * cd /home/SEU_USUARIO/tallybot && ./scripts/backup.sh
```

`backup.sh` usa `VACUUM INTO`, que produz arquivo íntegro mesmo com o container
escrevendo, e mantém os 30 mais recentes.

Para tirar a cópia de casa (recomendado — backup no mesmo disco não protege
contra perder o disco):

```cron
30 3 * * * rclone copy /home/SEU_USUARIO/tallybot/backups remoto:tallybot
```

## Fly.io

Alternativa se você não quer administrar um servidor. O Hermes suporta modo
webhook, o que combina com plataformas que hibernam a máquina:

```bash
fly launch --image nousresearch/hermes-agent:latest --no-deploy
fly volumes create hermes_data --size 3
fly secrets set OPENROUTER_API_KEY=... TELEGRAM_BOT_TOKEN=... \
                TELEGRAM_ALLOWED_USERS=... \
                TELEGRAM_WEBHOOK_URL=https://SEU-APP.fly.dev/telegram \
                TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32) \
                HERMES_DASHBOARD=0
```

**`TELEGRAM_WEBHOOK_SECRET` é obrigatório.** Sempre que `TELEGRAM_WEBHOOK_URL`
está definida, o Hermes **se recusa a subir** sem o secret — é o token que o
Telegram devolve em cada requisição e que permite ao gateway distinguir um update
real de qualquer um que descubra a URL. Gere com `openssl rand -hex 32`.

**`HERMES_DASHBOARD=0`** porque aqui não existe o `127.0.0.1` do compose para
proteger você: no Fly, o que estiver escutando pode acabar publicado, e o
dashboard mostra as chaves de API.

Sem `TALLY_ACCESS_CODE` na lista de propósito: cadastre as pessoas por convite
(`fly ssh console -C "node /opt/data/skills/finance/scripts/fin.ts auth invite
--label 'Namorada'"`), e nenhum código de acesso precisa virar secret. Se preferir o
modo simples, acrescente `TALLY_ACCESS_CODE=...` aí.

No `fly.toml`, monte o volume em `/opt/data` e use `command = ["gateway", "run"]`.

Duas ressalvas honestas: você precisa copiar `hermes/config.yaml`, `hermes/SOUL.md`
e a skill para dentro do volume (o Fly não faz bind mount do repositório como o
compose faz), e a máquina hibernando significa que o cron não dispara enquanto ela
está parada. Para relatórios agendados confiáveis, o VPS é mais simples.

## Segurança

Esta seção é honesta a respeito do que este desenho não protege. Leia antes de
colocar o ID de mais alguém na allowlist.

### A allowlist protege as credenciais, não só os números

O agente tem o toolset `terminal` e o `.env` está montado dentro do container em
`/opt/data/.env`. **Quem consegue conversar com o bot consegue pedir a ele que
imprima a chave da OpenRouter e o token do bot.** O `SOUL.md` instrui o agente a
não falar de detalhe técnico, mas instrução em prompt não é controle de acesso: um
LLM pode ser convencido.

Isso é inerente a dar um shell a um agente, não é um defeito específico do Tally.
A consequência prática é a que importa:

- `TELEGRAM_ALLOWED_USERS` é a **única** trava de verdade. O Hermes valida no
  gateway, antes de o modelo rodar, e sem allowlist nega todo mundo (fail-closed).
  Tudo o mais está dentro do raio de alcance de quem está na lista — inclusive o
  `TALLY_ACCESS_CODE`, que o agente lê no próprio ambiente com `env`. É por isso que
  vale cadastrar todo mundo por convite (`make invite LABEL="..."`) e **apagar essa
  variável do `.env` depois**: convite não fica no ambiente e o banco guarda só o
  hash dele, então não sobra segredo permanente para o agente imprimir.
- **Nunca ligue `GATEWAY_ALLOW_ALL_USERS`.**
- Só coloque na lista alguém em quem você confia no nível de "tem acesso a este
  container". Não existe ali um nível "só pode registrar gastos".
- Se você suspeitar de acesso indevido: `/revoke` no @BotFather, chave nova na
  OpenRouter e `make logout-all` (todos redigitam). Se a suspeita é de uma pessoa
  específica, `make revoke TG_USER=<id>` tira só ela, sem apagar dado nenhum — e
  aí apague o `TALLY_ACCESS_CODE`, senão ela volta digitando ele.

### As duas pessoas não estão isoladas uma da outra

Isto precisa estar escrito sem eufemismo, porque a documentação de uso fala em
"caixas separados" e é fácil ler mais do que está lá.

A separação por `user_id` é uma **garantia de correção**: uma auditoria varreu as
consultas de todos os comandos de dados e não achou vazamento nenhum — nem por ID
cru, nem por nome de conta ou categoria. No uso normal cada pessoa vê só o seu, e
os dois caixas nunca se misturam por acidente.

**Mas não é sigilo entre as duas.** A identidade que o `fin.ts` respeita vem de uma
variável de ambiente de um processo que o próprio agente dispara, e o agente tem
shell:

```bash
env -u HERMES_SESSION_USER_ID node fin.ts ls --period all --user <o outro ID>
```

Os IDs saem de `fin.ts auth users`, que não pede autenticação. Uma revisão
adversarial rodou isso contra um banco real de duas pessoas e obteve o extrato
completo da outra em dois comandos. Fechar essa brecha no CLI também não
resolveria: `node -e` com `node:sqlite` abre o `tally.db` direto, e a referência de
schema da skill até fornece o trecho pronto.

Portanto: as checagens de identidade e o código de acesso são **guarda-corpos**.
Impedem o bot de cruzar os caixas quando alguém pede casualmente, e impedem o erro
honesto. Não são uma parede contra quem sabe o que quer.

Para um casal que confia um no outro, isso é adequado — é o caso para o qual o bot
foi desenhado. **Se você precisa de isolamento real, a única configuração que
entrega é uma instância por pessoa:** um container, um volume e um token de bot
para cada. Na prática, dois diretórios com o mesmo repositório, cada um com seu
`.env` (token e `TELEGRAM_ALLOWED_USERS` diferentes) e seu `data/`, e
`container_name` distinto no compose. Custa o dobro de RAM e nenhuma linha de
código.

### A skill é montada read-only

O compose monta `./skills/finance` em `/opt/data/skills/finance` com `:ro`, e é o
padrão certo: sem isso o agente pode reescrever o código que roda na próxima
mensagem — inclusive o `fin.ts`, que é onde vivem as checagens de identidade e do
código de acesso.

Você pode abrir mão disso removendo o `:ro`:

```yaml
- ./skills/finance:/opt/data/skills/finance
```

O ganho é que melhorias que o próprio agente faz na skill aparecem como diff no
git, para você revisar e manter. O preço são as duas metades do mesmo fato: ele
pode alterar o que roda em seguida, e essas alterações entram num `git commit -a`
distraído. Se você optar por isso, revise o que commita.

### O dashboard

Fica **desligado por padrão** no compose (`HERMES_DASHBOARD` com default `0`) e,
quando ligado, escuta apenas em `127.0.0.1`. Ele mostra as chaves de API na tela.
Atenção: o `.env.example` ainda traz `HERMES_DASHBOARD=1`, então uma instalação
que copie o exemplo sem editar sobe com o dashboard ligado.

Para acessá-lo remotamente, túnel SSH — nunca abrindo a porta:

```bash
ssh -L 9119:localhost:9119 usuario@servidor
# depois abra http://localhost:9119 no seu navegador
```

⚠️ **Não troque o compose para `network_mode: host`.** Sob rede de host o prefixo
`127.0.0.1` da porta publicada deixa de valer, e o tratamento de portas do Docker
passa por cima de ufw/firewalld — um dashboard ligado ficaria alcançável pela rede
inteira, com firewall em pé e tudo. Se você realmente precisar de rede de host,
force `HERMES_DASHBOARD=0`.

### Segredos em disco

- **O `.env` fica fora do git.** O `.gitignore` cobre `.env*` (menos o
  `.env.example`), `exports/`, `*.csv` e os arquivos de banco (`*.db`, `-wal`,
  `-shm`, `.sqlite`). O glob `.env*` existe porque um `sed -i.bak` interrompido
  deixaria um `.env.bak` com as credenciais dentro.
- O bootstrap aplica `chmod 600` no `.env` **a cada execução**, não só na criação,
  e copia para `data/.env` também com `600`.
- **Nenhum código de acesso está no banco em texto claro.** O compartilhado vive em
  `TALLY_ACCESS_CODE` e é comparado por digestos SHA-256 com `timingSafeEqual`; de um
  convite o banco guarda só o SHA-256, e o código em si aparece uma única vez, na
  saída do `make invite`. Um backup não carrega nenhum dos dois.
- **O melhor estado é sem `TALLY_ACCESS_CODE` nenhum.** Depois que todas as pessoas
  entraram por convite, apague a variável do `.env` e `make restart`: ninguém é
  desconectado (a sessão está no banco) e passa a não existir segredo permanente no
  ambiente do container. O bootstrap aceita a variável vazia — ele só reclama se
  ninguém puder entrar.
- Trocar o valor de `TALLY_ACCESS_CODE` **não** desconecta ninguém: quem já está
  dentro continua dentro. Para tirar uma pessoa, `make revoke TG_USER=<id>`; para
  forçar todo mundo a digitar de novo, `make logout-all`. Nenhum dos dois apaga um
  lançamento.

**Se o token do bot vazar**, mande `/revoke` para o @BotFather, gere outro e
atualize o `.env`. Quem tem o token controla o bot.

### Se você for reaproveitar este projeto

O `hermes/SOUL.md` tem nomes de pessoa escritos à mão — "Geovane e sua namorada" —
e as mensagens de erro do `fin.ts` mandam "avisar o Geovane". Troque pelos nomes de
quem for usar, ou o bot vai falar de estranhos com os seus usuários.

## Atualizando

```bash
git pull
make pull      # baixa a imagem nova e recria o container
make restart   # reaplica config.yaml e SOUL.md
```

Seus dados ficam em `data/` e sobrevivem à troca de imagem. O Hermes roda
migrações de config no boot e escreve backup com timestamp antes de alterar
qualquer coisa. As migrações do banco do Tally rodam no `make up`, são idempotentes
e aplicam só o que falta.

Se o `git pull` trouxe mudança em `hermes/cron-jobs.sh`, rode `make cron-install`
de novo para recriar os jobs.

Se após atualizar a imagem o log pedir migração de config, entre no container e
rode `hermes config migrate`, depois traga o novo `_config_version` para
`hermes/config.yaml`.
