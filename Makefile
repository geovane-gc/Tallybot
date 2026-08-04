.DEFAULT_GOAL := help
SHELL := /bin/bash

DATA := ./data
DB   := $(DATA)/finance/tally.db
FIN  := node skills/finance/scripts/fin.ts --db $(DB)

# Whose ledger the shortcuts below act on, as a Telegram user id.
#
# Named TG_USER and not USER: make imports the environment, so USER already
# holds your login name and `make balance` would silently ask for the ledger of
# somebody called "geovane" — which does not exist, and the error would not say
# why.
TG_USER ?=

# Every ledger target starts with this. `$@` is the target being run, so the
# message tells you exactly what to retype.
define need_user
	@if [ -z "$(TG_USER)" ]; then \
		echo "This ledger has one set of numbers per person, so pick one:"; \
		echo; \
		echo "    make $@ TG_USER=<telegram id>"; \
		echo; \
		echo "Run 'make users' to see the registered ids."; \
		exit 1; \
	fi
endef

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

# --- access ------------------------------------------------------------------

.PHONY: users
users: ## List the registered people and their ids
	@$(FIN) auth users

.PHONY: logout-all
logout-all: ## Force everyone to re-enter the access code (no data is deleted)
	@$(FIN) auth logout-all

# --- ledger (straight to the database, bypassing the agent) ------------------
#
# All of these need TG_USER=<telegram id>. See 'make users'.

.PHONY: balance
balance: ## Current balance per account (needs TG_USER)
	$(need_user)
	@$(FIN) balance --user $(TG_USER)

.PHONY: summary
summary: ## Summary for the current month (needs TG_USER)
	$(need_user)
	@$(FIN) summary --period month --user $(TG_USER)

.PHONY: report
report: ## Formatted monthly report (needs TG_USER)
	$(need_user)
	@$(FIN) report --period month --user $(TG_USER)

.PHONY: export
export: ## Export the month's transactions to CSV (needs TG_USER)
	$(need_user)
	@$(FIN) export --period month --format csv --user $(TG_USER)

.PHONY: backup
backup: ## Consistent database backup into backups/
	@bash scripts/backup.sh

# --- development -------------------------------------------------------------

.PHONY: test
test: ## Run the test suite
	node --test tests/*.test.ts

.PHONY: clean-data
clean-data: ## DELETE all local state (database, sessions, memories)
	@read -p "This wipes all of data/, including your transactions. Type 'yes': " ok; \
	if [[ "$$ok" == "yes" ]]; then rm -rf $(DATA); echo "data/ removed."; \
	else echo "Cancelled."; fi
