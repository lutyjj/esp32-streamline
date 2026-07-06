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

test:
	@true

image: lint
	$(CONTAINER) build --platform $(PLATFORM) -f Dockerfile \
		--build-arg BUILD_VERSION=$(VERSION) \
		--build-arg BUILD_ARCH=$(BUILD_ARCH) \
		-t $(IMAGE):$(VERSION) \
		..

check: lint test image
