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
git clone git@github.com:geovane-gc/financas-bot.git
cd financas-bot
cp .env.example .env
$EDITOR .env          # as mesmas três variáveis do setup local
make up
make cron-install
```

É o mesmo fluxo do ambiente local — o compose não tem nada específico de macOS.

**Não rode as duas instâncias ao mesmo tempo.** A documentação do Hermes é
explícita: dois gateways contra o mesmo diretório de dados corrompem sessões e
memórias. E dois bots com o mesmo token brigam pelo long polling. Antes de subir
no servidor, `make down` no Mac.

## Levando seus dados

Se você já usou o bot localmente e quer manter o histórico:

```bash
# no Mac
make backup
scp backups/financas-*.db.gz usuario@servidor:~/

# no servidor
mkdir -p ~/financas-bot/data/financas
gunzip -c ~/financas-2026*.db.gz > ~/financas-bot/data/financas/financas.db
```

Só o banco precisa viajar. Sessões e memórias do agente podem começar do zero — a
carteira é o que importa.

## Iniciar no boot

O `restart: unless-stopped` do compose religa o container se ele cair, mas não se
o servidor reiniciar sem o Docker subir sozinho. Garanta:

```bash
sudo systemctl enable docker
```

Se preferir amarrar o compose ao boot explicitamente:

```ini
# /etc/systemd/system/financas-bot.service
[Unit]
Description=Bot financeiro no Telegram
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/SEU_USUARIO/financas-bot
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=SEU_USUARIO

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now financas-bot
```

## Backup automático

O banco cabe em kilobytes, então backup diário é barato. No crontab do servidor:

```cron
0 3 * * * cd /home/SEU_USUARIO/financas-bot && ./scripts/backup.sh
```

`backup.sh` usa `VACUUM INTO`, que produz arquivo íntegro mesmo com o container
escrevendo, e mantém os 30 mais recentes.

Para tirar a cópia de casa (recomendado — backup no mesmo disco não protege
contra perder o disco):

```cron
30 3 * * * rclone copy /home/SEU_USUARIO/financas-bot/backups remoto:financas-bot
```

## Fly.io

Alternativa se você não quer administrar um servidor. O Hermes suporta modo
webhook, o que combina com plataformas que hibernam a máquina:

```bash
fly launch --image nousresearch/hermes-agent:latest --no-deploy
fly volumes create hermes_data --size 3
fly secrets set OPENROUTER_API_KEY=... TELEGRAM_BOT_TOKEN=... \
                TELEGRAM_ALLOWED_USERS=... TELEGRAM_WEBHOOK_URL=https://SEU-APP.fly.dev/telegram
```

No `fly.toml`, monte o volume em `/opt/data` e use `command = ["gateway", "run"]`.

Duas ressalvas honestas: você precisa copiar `hermes/config.yaml`, `hermes/SOUL.md`
e a skill para dentro do volume (o Fly não faz bind mount do repositório como o
compose faz), e a máquina hibernando significa que o cron não dispara enquanto ela
está parada. Para relatórios agendados confiáveis, o VPS é mais simples.

## Segurança

**O dashboard nunca deve ficar exposto.** Ele mostra as chaves de API. O compose
publica em `127.0.0.1` de propósito. Para acessá-lo remotamente, túnel SSH:

```bash
ssh -L 9119:localhost:9119 usuario@servidor
# depois abra http://localhost:9119 no seu navegador
```

**A allowlist é a única trava do bot.** `TELEGRAM_ALLOWED_USERS` com o seu ID
significa que mais ninguém consegue conversar com ele, mesmo conhecendo o
username. Nunca ligue `GATEWAY_ALLOW_ALL_USERS`.

**O `.env` fica fora do git** (`.gitignore`), e o bootstrap copia para
`data/.env` com permissão `600`.

**Se o token do bot vazar**, mande `/revoke` para o @BotFather, gere outro e
atualize o `.env`. Quem tem o token controla o bot.

## Atualizando

```bash
git pull
make pull      # baixa a imagem nova e recria o container
make restart   # reaplica config.yaml e SOUL.md
```

Seus dados ficam em `data/` e sobrevivem à troca de imagem. O Hermes roda
migrações de config no boot e escreve backup com timestamp antes de alterar
qualquer coisa.

Se após atualizar a imagem o log pedir migração de config, entre no container e
rode `hermes config migrate`, depois traga o novo `_config_version` para
`hermes/config.yaml`.
