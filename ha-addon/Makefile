include ../mk/common.mk

VERSION ?= $(call toml_version,../bridge/pyproject.toml)
HOST_ARCH := $(shell uname -m)
DEFAULT_BUILD_ARCH := $(if $(filter arm64 aarch64,$(HOST_ARCH)),aarch64,amd64)
BUILD_ARCH ?= $(DEFAULT_BUILD_ARCH)
IMAGE := $(or $(ADDON_IMAGE),$(BUILD_ARCH)-esp32-streamline-bridge-addon)
PLATFORM := $(if $(filter aarch64,$(BUILD_ARCH)),linux/arm64,linux/amd64)
CONFIG_VERSION := $(shell sed -n 's/^version: "\([^"]*\)".*/\1/p' config.yaml)

# `make context` assembles this self-contained add-on tree from the bridge
# distribution and the freshly built console asset; every build and the
# validator consume it. Gitignored — it is generated, never committed.
BUILD_CONTEXT := .build-context

# The official Home Assistant add-on builder is the owning ecosystem's tool:
# it loads config.yaml, maps architectures, and builds the image the store
# builds. `--test` validates and builds without pushing. Pinned by digest.
HA_BUILDER := ghcr.io/home-assistant/amd64-builder:2025.09.0@sha256:ca73413c439709af27251a205fbcda9f50e6e9e556c6adb856ec123e36c26799
HA_BUILDER_RUN = $(CONTAINER) run --rm --privileged \
	-v /var/run/docker.sock:/var/run/docker.sock

# Build arguments shared by every image build so the local image, the release
# image, and the validator agree on the labels they stamp.
ADDON_BUILD_ARGS := --build-arg BUILD_VERSION=$(VERSION)

.PHONY: format lint context validate test image check

format:
	@true

lint:
	@test "$(BUILD_ARCH)" = "amd64" -o "$(BUILD_ARCH)" = "aarch64" || (echo "BUILD_ARCH must be amd64 or aarch64" >&2; exit 2)
	@test "$(VERSION)" = "$(CONFIG_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(CONFIG_VERSION))" >&2; exit 2)

# A standard Home Assistant add-on context: the bridge distribution plus the
# freshly built console asset and config.yaml, with no reach into the bridge
# source tree. This is what lets the ecosystem builder consume the add-on
# unchanged and keeps a build from mutating a sibling component.
context:
	$(MAKE) -C ../console build-bridge
	rm -rf $(BUILD_CONTEXT)
	mkdir -p $(BUILD_CONTEXT)/src
	cp Dockerfile config.yaml $(BUILD_CONTEXT)/
	cp ../bridge/pyproject.toml ../bridge/uv.lock $(BUILD_CONTEXT)/
	cp -R ../bridge/src/streamline_bridge $(BUILD_CONTEXT)/src/
	cp ../console/dist/bridge/bridge.html $(BUILD_CONTEXT)/src/streamline_bridge/console.html

# Run the owning ecosystem's validator and builder tests. The official builder
# validates config.yaml semantics and builds both published architectures; a
# malformed-but-valid-YAML fixture proves the gate actually rejects bad
# metadata. Option and schema parity stays with the bridge (test_ha_addon.py).
validate: context
	$(HA_BUILDER_RUN) -v "$(CURDIR)/$(BUILD_CONTEXT):/data:ro" $(HA_BUILDER) \
		--test --amd64 --aarch64 -t /data --no-latest --no-cache
	@set -eu; \
		neg="$$(mktemp -d /tmp/streamline-addon-validate.XXXXXX)"; \
		trap 'rm -rf "$$neg"' EXIT INT TERM; \
		cp -R $(BUILD_CONTEXT)/. "$$neg"/; \
		grep -v '^  - amd64$$' $(BUILD_CONTEXT)/config.yaml > "$$neg/config.yaml"; \
		if $(HA_BUILDER_RUN) -v "$$neg:/data:ro" $(HA_BUILDER) --test --amd64 -t /data --no-latest --no-cache >/dev/null 2>&1; then \
			echo "validator accepted metadata whose arch list omits the requested amd64" >&2; exit 1; \
		fi; \
		echo "validator rejected the malformed-metadata fixture"

image: lint context
	$(CONTAINER) build --platform $(PLATFORM) $(ADDON_BUILD_ARGS) \
		--build-arg BUILD_ARCH=$(BUILD_ARCH) \
		-t $(IMAGE):$(VERSION) \
		$(BUILD_CONTEXT)

# This is intentionally an image test: Supervisor /data permissions depend on
# the final container user and cannot be proven by bridge unit tests alone.
test: image
	@set -eu; \
	volume="$$($(CONTAINER) volume create)"; \
	stub_dir="$$(mktemp -d /tmp/streamline-ha-addon-test.XXXXXX)"; \
	cleanup() { \
		$(CONTAINER) volume rm -f "$$volume" >/dev/null; \
		rm -rf "$$stub_dir"; \
	}; \
	trap cleanup EXIT INT TERM; \
	$(CONTAINER) run --rm --platform $(PLATFORM) --user 0:0 --entrypoint sh \
		-v "$$volume:/data" \
		"$(IMAGE):$(VERSION)" \
		-c 'printf "%s\n" "{\"max_sources\": 3, \"recordings_enabled\": true, \"api_token\": \"test-bridge-api-token\"}" > /data/options.json && chown 0:0 /data/options.json && chmod 600 /data/options.json'; \
	printf '%s\n' \
		'#!/bin/sh' \
		'test "$$#" -eq 6' \
		'test "$$1" = "--transport-state-file"' \
		'test "$$2" = "/data/transport.json"' \
		'test "$$3" = "--recordings-dir"' \
		'test "$$4" = "/data/recordings"' \
		'test "$$5" = "--max-sources"' \
		'test "$$6" = "3"' \
		'test "$$STREAMLINE_API_TOKEN" = "test-bridge-api-token"' \
		'mkdir "$$4"' \
		'test -w "$$4"' \
		'touch "$$2"' \
		'test -w "$$2"' \
		> "$$stub_dir/streamline-bridge"; \
	chmod +x "$$stub_dir/streamline-bridge"; \
	$(CONTAINER) run --rm --platform $(PLATFORM) \
		-v "$$volume:/data" \
		-v "$$stub_dir:/test-bin:ro" \
		-e PATH="/test-bin:/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
		"$(IMAGE):$(VERSION)"

check: lint validate test
