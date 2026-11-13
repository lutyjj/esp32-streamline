include ../mk/common.mk

DEV_IMAGE := esp32-streamline-console-dev
E2E_IMAGE := esp32-streamline-console-e2e
WEBFLASHER_DIR := $(abspath ../webflasher)

# Consoles run against a real bridge; only the device is mocked.
BRIDGE_IMAGE_TAG := esp32-streamline-bridge:$(call toml_version,../bridge/pyproject.toml)
BRIDGE_TOKEN ?= streamline-dev-bridge-token
DEV_NET := streamline-console-dev
DEV_BRIDGE := streamline-dev-bridge
E2E_NET := streamline-console-e2e
E2E_BRIDGE := streamline-e2e-bridge

# $(call bridge_up,<network>,<container>[,<extra flags>]) starts a fresh bridge and
# arms the caller's exit trap.
define bridge_up
$(CONTAINER) network create $(1) >/dev/null 2>&1 || true; \
$(CONTAINER) rm -f $(2) >/dev/null 2>&1 || true; \
$(CONTAINER) run -d --rm --name $(2) --network $(1) --tmpfs /tmp \
	-e STREAMLINE_API_TOKEN=$(BRIDGE_TOKEN) $(3) $(BRIDGE_IMAGE_TAG) \
	--transport-state-file /tmp/transport.json --recordings-dir /tmp/recordings >/dev/null; \
trap '$(CONTAINER) rm -f $(2) >/dev/null 2>&1' EXIT
endef
# Defaults to STREAMLINE_DEVICE from the root .env, else the setup-AP address.
DEVICE ?= $(or $(call dotenv,STREAMLINE_DEVICE),192.168.71.1)
HOST_USER := $(shell id -u):$(shell id -g)
ROOT_DIR := $(abspath ..)
WORKSPACE := /repo

CONTAINER_BASE := $(CONTAINER) run --rm \
	--user "$(HOST_USER)" -v "$(ROOT_DIR):$(WORKSPACE)" \
	-v "$(WEBFLASHER_DIR):/webflasher:ro" -e STREAMLINE_WEBFLASHER_DIR=/webflasher \
	-e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
	-e npm_config_update_notifier=false -w $(WORKSPACE)/console
CONTAINER_RUN := $(CONTAINER_BASE) $(DEV_IMAGE)

.PHONY: dev-image e2e-image bridge-image deps lock generate format lint test e2e build build-bridge dev dev-mock

dev-image:
	$(CONTAINER) build -f Dockerfile.dev -t $(DEV_IMAGE) .

e2e-image:
	$(CONTAINER) build -f Dockerfile.e2e -t $(E2E_IMAGE) .

bridge-image:
	$(MAKE) -C ../bridge image

# npm ci wipes node_modules, so it reruns only when the lockfile moves. `lock` rewrites
# npm's own node_modules/.package-lock.json, so the stamp is a file npm never writes.
node_modules/.npm-ci-stamp: package.json package-lock.json | dev-image
	$(CONTAINER_RUN) sh -c 'npm ci && touch $@'

deps: node_modules/.npm-ci-stamp

lock: dev-image
	$(CONTAINER_RUN) npm install --package-lock-only --ignore-scripts

generate: deps
	$(CONTAINER_RUN) npx orval --fail-on-warnings

format: generate
	$(CONTAINER_RUN) npx biome check --write .

lint: generate
	$(CONTAINER_RUN) npx biome check .
	$(CONTAINER_RUN) npx tsc

test: generate
	$(CONTAINER_RUN) npx vitest run

e2e: generate e2e-image bridge-image
	@set -e; $(call bridge_up,$(E2E_NET),$(E2E_BRIDGE)); \
	$(CONTAINER_BASE) --network $(E2E_NET) -e STREAMLINE_BRIDGE=$(E2E_BRIDGE):8088 \
		-e STREAMLINE_API_TOKEN=$(BRIDGE_TOKEN) $(E2E_IMAGE) npx playwright test

# The WebFlasher builds as its own pass: vite-plugin-singlefile inlines one entry per
# Rollup pass.
build: generate
	$(CONTAINER_RUN) npx vite build
	$(CONTAINER_RUN) sh -c 'STREAMLINE_BUILD=flasher npx vite build'
	$(CONTAINER_RUN) sh -c 'STREAMLINE_BUILD=bridge npx vite build'

build-bridge: generate
	$(CONTAINER_RUN) sh -c 'STREAMLINE_BUILD=bridge npx vite build'

DEV_PORT ?= 5173
DEV_SERVE := $(CONTAINER) run --rm --user "$(HOST_USER)" -v "$(ROOT_DIR):$(WORKSPACE)" \
	-v "$(WEBFLASHER_DIR):/webflasher:ro" -e STREAMLINE_WEBFLASHER_DIR=/webflasher \
	-e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
	-e npm_config_update_notifier=false -p $(DEV_PORT):5173 -w $(WORKSPACE)/console

# CONTRIBUTING.md#development documents dev and dev-mock.
dev: deps
	$(DEV_SERVE) -e STREAMLINE_DEVICE=$(DEVICE) $(DEV_IMAGE) npx vite --host

# DEV_BRIDGE_FLAGS='-p 39000:39000' lets a real device stream into the dev bridge.
DEV_BRIDGE_FLAGS ?=
dev-mock: deps bridge-image
	@set -e; $(call bridge_up,$(DEV_NET),$(DEV_BRIDGE),$(DEV_BRIDGE_FLAGS)); \
	$(DEV_SERVE) --network $(DEV_NET) -e VITE_MOCK=1 \
		-e STREAMLINE_BRIDGE=$(DEV_BRIDGE):8088 $(DEV_IMAGE) npx vite --host
