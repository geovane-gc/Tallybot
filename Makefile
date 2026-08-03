.DEFAULT_GOAL := help
SHELL := /bin/bash

DATA := ./data
DB   := $(DATA)/financas/financas.db
FIN  := node skills/financas/scripts/fin.ts --db $(DB)

.PHONY: help
help: ## Mostra esta ajuda
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- ciclo de vida -----------------------------------------------------------

.PHONY: bootstrap
bootstrap: ## Valida .env, prepara data/ e cria o banco
	@bash scripts/bootstrap.sh

.PHONY: up
up: bootstrap ## Sobe o bot (bootstrap + docker compose up -d)
	docker compose up -d
	@echo
	@echo "Bot de pé. Acompanhe com 'make logs' e mande uma mensagem no Telegram."

.PHONY: down
down: ## Para o bot
	docker compose down

.PHONY: restart
restart: ## Reinicia aplicando mudanças de config.yaml/SOUL.md
	@bash scripts/bootstrap.sh
	docker compose restart

.PHONY: logs
logs: ## Segue os logs do gateway
	docker compose logs -f --tail 100

.PHONY: pull
pull: ## Atualiza a imagem do Hermes
	docker compose pull
	docker compose up -d

.PHONY: ps
ps: ## Status do container
	docker compose ps

# --- operação ----------------------------------------------------------------

.PHONY: shell
shell: ## Shell dentro do container (como usuário hermes)
	docker compose exec hermes bash

.PHONY: chat
chat: ## Conversa com o agente pelo terminal, sem passar pelo Telegram
	docker compose exec hermes hermes

.PHONY: cron-install
cron-install: ## Cria os relatórios agendados e a checagem de limites
	@bash hermes/cron-jobs.sh

.PHONY: cron-list
cron-list: ## Lista os jobs agendados
	docker compose exec hermes hermes cron list

.PHONY: doctor
doctor: ## Diagnóstico do Hermes (chaves, modelo, gateway)
	docker compose exec hermes hermes doctor

# --- finanças (direto no banco, sem passar pelo agente) ----------------------

.PHONY: saldo
saldo: ## Saldo atual por conta
	@$(FIN) saldo

.PHONY: resumo
resumo: ## Resumo do mês corrente
	@$(FIN) resumo --periodo mes

.PHONY: relatorio
relatorio: ## Relatório mensal formatado
	@$(FIN) relatorio --periodo mes

.PHONY: export
export: ## Exporta os lançamentos do mês para CSV
	@$(FIN) export --periodo mes --formato csv

.PHONY: backup
backup: ## Backup consistente do banco em backups/
	@bash scripts/backup.sh

# --- desenvolvimento ---------------------------------------------------------

.PHONY: test
test: ## Roda a suíte de testes
	node --test tests/fin.test.ts

.PHONY: clean-data
clean-data: ## APAGA todo o estado local (banco, sessões, memórias)
	@read -p "Isso apaga data/ inteiro, incluindo seus lançamentos. Digite 'sim': " ok; \
	if [[ "$$ok" == "sim" ]]; then rm -rf $(DATA); echo "data/ removido."; \
	else echo "Cancelado."; fi
