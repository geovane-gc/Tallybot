.DEFAULT_GOAL := help
SHELL := /bin/bash

DATA := ./data
DB   := $(DATA)/finance/tally.db
FIN  := node skills/finance/scripts/fin.ts --db $(DB)

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- lifecycle ---------------------------------------------------------------

.PHONY: bootstrap
bootstrap: ## Validate .env, prepare data/ and create the database
	@bash scripts/bootstrap.sh

.PHONY: up
up: bootstrap ## Start the bot (bootstrap + docker compose up -d)
	docker compose up -d
	@echo
	@echo "Bot is up. Follow it with 'make logs' and send a message on Telegram."

.PHONY: down
down: ## Stop the bot
	docker compose down

.PHONY: restart
restart: ## Restart, applying changes to config.yaml / SOUL.md
	@bash scripts/bootstrap.sh
	docker compose restart

.PHONY: logs
logs: ## Follow the gateway logs
	docker compose logs -f --tail 100

.PHONY: pull
pull: ## Update the Hermes image
	docker compose pull
	docker compose up -d

.PHONY: ps
ps: ## Container status
	docker compose ps

# --- operations --------------------------------------------------------------

.PHONY: shell
shell: ## Shell inside the container (as the hermes user)
	docker compose exec hermes bash

.PHONY: chat
chat: ## Talk to the agent from the terminal, bypassing Telegram
	docker compose exec hermes hermes

.PHONY: cron-install
cron-install: ## Create the scheduled reports and the budget checks
	@bash hermes/cron-jobs.sh

.PHONY: cron-list
cron-list: ## List the scheduled jobs
	docker compose exec hermes hermes cron list

.PHONY: doctor
doctor: ## Hermes diagnostics (keys, model, gateway)
	docker compose exec hermes hermes doctor

# --- ledger (straight to the database, bypassing the agent) ------------------

.PHONY: balance
balance: ## Current balance per account
	@$(FIN) balance

.PHONY: summary
summary: ## Summary for the current month
	@$(FIN) summary --period month

.PHONY: report
report: ## Formatted monthly report
	@$(FIN) report --period month

.PHONY: export
export: ## Export the month's transactions to CSV
	@$(FIN) export --period month --format csv

.PHONY: backup
backup: ## Consistent database backup into backups/
	@bash scripts/backup.sh

# --- development -------------------------------------------------------------

.PHONY: test
test: ## Run the test suite
	node --test tests/fin.test.ts

.PHONY: clean-data
clean-data: ## DELETE all local state (database, sessions, memories)
	@read -p "This wipes all of data/, including your transactions. Type 'yes': " ok; \
	if [[ "$$ok" == "yes" ]]; then rm -rf $(DATA); echo "data/ removed."; \
	else echo "Cancelled."; fi
