# AI Gateway — local dev automation
# Run `make help` for targets.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
COMPOSE_DIR := $(ROOT)/deploy/compose
COMPOSE := docker compose --env-file $(COMPOSE_DIR)/.env -f $(COMPOSE_DIR)/docker-compose.yml

EDGE_URL ?= http://localhost:8080
DEV_IDP_URL ?= http://localhost:4000
EDGE_AUDIENCE ?= api://ai-gateway-edge
MODEL ?= gpt-4.1
MSG ?= hello

.PHONY: help env up up-fg down down-v restart ps status logs logs-gateway logs-edge \
        e2e smoke test test-gateway test-collector typecheck token chat codex responses rebuild

.DEFAULT_GOAL := help

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Examples:"
	@echo "  make up && make e2e"
	@echo "  make chat MODEL=gpt-5.1-codex-mini MSG='Reply pong'"
	@echo "  make smoke    # up (detached) + wait healthy + e2e"

env: $(COMPOSE_DIR)/.env ## Create deploy/compose/.env from .env.example if missing

$(COMPOSE_DIR)/.env:
	@test -f $@ || (cp $(COMPOSE_DIR)/.env.example $@ && echo "Created $@")

up: env ## Build and start full stack (detached)
	$(COMPOSE) up --build -d
	@$(MAKE) --no-print-directory ps

up-fg: env ## Build and start full stack (foreground)
	$(COMPOSE) up --build

down: ## Stop stack (keep volumes)
	$(COMPOSE) down

down-v: ## Stop stack and remove volumes
	$(COMPOSE) down -v

restart: ## Restart all compose services
	$(COMPOSE) restart

ps status: env ## Show compose service status
	@$(COMPOSE) ps

logs: env ## Tail all service logs
	$(COMPOSE) logs -f

logs-gateway: env ## Tail gateway logs
	$(COMPOSE) logs -f gateway

logs-edge: env ## Tail edge logs
	$(COMPOSE) logs -f edge

rebuild: env ## Rebuild images and recreate containers
	$(COMPOSE) up --build -d --force-recreate

e2e: env ## Run compose smoke tests (stack must be up)
	@$(COMPOSE_DIR)/local-e2e.sh

smoke: env ## up + wait for health + e2e
	@$(MAKE) --no-print-directory up
	@echo "==> waiting for edge /health"
	@for i in $$(seq 1 60); do \
		curl -sf "$(EDGE_URL)/health" >/dev/null 2>&1 && break; \
		sleep 2; \
	done
	@$(MAKE) --no-print-directory e2e

test-gateway: ## Run gateway unit tests
	cd $(ROOT)/services/gateway && yarn test

test-collector: ## Run collector unit tests
	cd $(ROOT)/services/collector && yarn test

test: test-gateway test-collector ## Run all Node service unit tests

typecheck: ## Typecheck gateway + collector
	cd $(ROOT)/services/gateway && yarn typecheck
	cd $(ROOT)/services/collector && yarn typecheck

token: ## Mint a dev SP token (seed-sp-appid) to stdout
	@curl -sf -X POST "$(DEV_IDP_URL)/token" \
		-H 'content-type: application/json' \
		-d '{"audience":"$(EDGE_AUDIENCE)","claims":{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}}' \
		| jq -r .access_token

chat: env ## POST /v1/chat/completions (MODEL, MSG env vars)
	@TOKEN=$$($(MAKE) --no-print-directory token); \
	curl -sf -X POST "$(EDGE_URL)/v1/chat/completions" \
		-H "authorization: Bearer $$TOKEN" \
		-H 'content-type: application/json' \
		-d "{\"model\":\"$(MODEL)\",\"messages\":[{\"role\":\"user\",\"content\":\"$(MSG)\"}]}" \
		| jq .

codex: ## Chat-completions bridge smoke for gpt-5.1-codex-mini
	@$(MAKE) --no-print-directory chat MODEL=gpt-5.1-codex-mini MSG='Reply with exactly: pong'

responses: env ## POST /v1/responses (MODEL, MSG env vars)
	@TOKEN=$$($(MAKE) --no-print-directory token); \
	curl -sf -X POST "$(EDGE_URL)/v1/responses" \
		-H "authorization: Bearer $$TOKEN" \
		-H 'content-type: application/json' \
		-d "{\"model\":\"$(MODEL)\",\"input\":\"$(MSG)\"}" \
		| jq .

smoke-evidence: env ## Run gateway + direct smoke tests → http/evidence/*.json
	@$(ROOT)/http/run-smoke-evidence.sh
