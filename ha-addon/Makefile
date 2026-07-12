include ../mk/common.mk

VERSION ?= $(call toml_version,../bridge/pyproject.toml)
HOST_ARCH := $(shell uname -m)
DEFAULT_BUILD_ARCH := $(if $(filter arm64 aarch64,$(HOST_ARCH)),aarch64,amd64)
BUILD_ARCH ?= $(DEFAULT_BUILD_ARCH)
IMAGE := $(or $(ADDON_IMAGE),$(BUILD_ARCH)-esp32-streamline-bridge-addon)
PLATFORM := $(if $(filter aarch64,$(BUILD_ARCH)),linux/arm64,linux/amd64)
CONFIG_VERSION := $(shell sed -n 's/^version: "\([^"]*\)"/\1/p' config.yaml)

.PHONY: format lint test image check

format:
	@true

lint:
	@test "$(BUILD_ARCH)" = "amd64" -o "$(BUILD_ARCH)" = "aarch64" || (echo "BUILD_ARCH must be amd64 or aarch64" >&2; exit 2)
	@test "$(VERSION)" = "$(CONFIG_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(CONFIG_VERSION))" >&2; exit 2)

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
		-c 'printf "%s\n" "{\"max_sources\": 3, \"recordings_enabled\": true, \"recording_token\": \"test-recording-token\"}" > /data/options.json && chown 0:0 /data/options.json && chmod 600 /data/options.json'; \
	printf '%s\n' \
		'#!/bin/sh' \
		'test "$$#" -eq 4' \
		'test "$$1" = "--recordings-dir"' \
		'test "$$2" = "/data/recordings"' \
		'test "$$3" = "--max-sources"' \
		'test "$$4" = "3"' \
		'test "$$STREAMLINE_RECORDING_TOKEN" = "test-recording-token"' \
		'mkdir "$$2"' \
		'test -w "$$2"' \
		> "$$stub_dir/streamline-bridge"; \
	chmod +x "$$stub_dir/streamline-bridge"; \
	$(CONTAINER) run --rm --platform $(PLATFORM) \
		-v "$$volume:/data" \
		-v "$$stub_dir:/test-bin:ro" \
		-e PATH="/test-bin:/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
		"$(IMAGE):$(VERSION)"

image: lint
	$(CONTAINER) build --platform $(PLATFORM) -f Dockerfile \
		--build-arg BUILD_VERSION=$(VERSION) \
		--build-arg BUILD_ARCH=$(BUILD_ARCH) \
		-t $(IMAGE):$(VERSION) \
		..

check: lint image test
