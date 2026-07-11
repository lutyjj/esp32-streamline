include ../mk/common.mk

DEV_IMAGE := esp32-streamline-console-dev
WEBFLASHER_DIR := $(abspath ../webflasher)
# Device the vite dev server proxies /api to; see the `dev` target. Defaults
# to STREAMLINE_DEVICE from the root .env, else the setup-AP address.
DEVICE ?= $(or $(call dotenv,STREAMLINE_DEVICE),192.168.71.1)
HOST_USER := $(shell id -u):$(shell id -g)
ROOT_DIR := $(abspath ..)
WORKSPACE := /repo

CONTAINER_RUN := $(CONTAINER) run --rm \
	--user "$(HOST_USER)" -v "$(ROOT_DIR):$(WORKSPACE)" \
	-v "$(WEBFLASHER_DIR):/webflasher:ro" -e STREAMLINE_WEBFLASHER_DIR=/webflasher \
	-e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
	-e npm_config_update_notifier=false -w $(WORKSPACE)/console $(DEV_IMAGE)

.PHONY: dev-image deps lock generate format lint test build dev

dev-image:
	$(CONTAINER) build -f Dockerfile.dev -t $(DEV_IMAGE) .

# npm ci wipes node_modules on every run; the stamp reruns it only when the
# lockfile actually moved.
node_modules/.package-lock.json: package.json package-lock.json | dev-image
	$(CONTAINER_RUN) sh -c 'npm ci && touch $@'

deps: node_modules/.package-lock.json

# Refresh package-lock.json in the same pinned Node container used for checks.
lock: dev-image
	$(CONTAINER_RUN) npm install --package-lock-only --ignore-scripts

generate: deps
	$(CONTAINER_RUN) npx openapi-typescript ../docs/openapi.json -o src/generated/api.ts

format: generate
	$(CONTAINER_RUN) npx biome check --write .

lint: generate
	$(CONTAINER_RUN) npx biome check .
	$(CONTAINER_RUN) npx tsc

test: generate
	$(CONTAINER_RUN) npx vitest run

# One self-contained HTML file in dist/; the firmware embeds it at compile
# time (see the `web` target in firmware/Makefile). The WebFlasher builds as a
# second single-file entry because vite-plugin-singlefile inlines one entry per
# Rollup pass.
build: generate
	$(CONTAINER_RUN) npx vite build
	$(CONTAINER_RUN) sh -c 'STREAMLINE_BUILD=flasher npx vite build'

# Live-reload UI development against a real device:
# `make dev DEVICE=192.0.2.10` (or set STREAMLINE_DEVICE in the root .env),
# then open http://localhost:5173/.
dev: deps
	$(CONTAINER) run --rm --user "$(HOST_USER)" -v "$(ROOT_DIR):$(WORKSPACE)" \
		-v "$(WEBFLASHER_DIR):/webflasher:ro" -e STREAMLINE_WEBFLASHER_DIR=/webflasher \
		-e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
		-e npm_config_update_notifier=false \
		-e STREAMLINE_DEVICE=$(DEVICE) -p 5173:5173 -w $(WORKSPACE)/console \
		$(DEV_IMAGE) npx vite --host
