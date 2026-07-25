include ../mk/common.mk

VERSION ?= $(call toml_version,../bridge/pyproject.toml)
HOST_ARCH := $(shell uname -m)
DEFAULT_BUILD_ARCH := $(if $(filter arm64 aarch64,$(HOST_ARCH)),aarch64,amd64)
BUILD_ARCH ?= $(DEFAULT_BUILD_ARCH)
IMAGE := $(BUILD_ARCH)-esp32-streamline-bridge-addon
PLATFORM := $(if $(filter aarch64,$(BUILD_ARCH)),linux/arm64,linux/amd64)
CONFIG_VERSION := $(shell sed -n 's/^version: "\([^"]*\)".*/\1/p' config.yaml)
SLUG := $(shell sed -n 's/^slug: *//p' config.yaml)
APPARMOR_PROFILE := $(shell sed -n 's/^profile \([^ ]*\).*/\1/p' apparmor.txt)
REVISION ?= $(shell git -C $(REPO_ROOT) rev-parse HEAD 2>/dev/null || echo unknown)

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

# Published add-on image names come from config.yaml's `image:` template — the
# add-on's own source of truth — so the Makefile and the store agree by
# construction. Override the whole name per arch to publish under another owner.
IMAGE_TEMPLATE := $(shell sed -n 's/^image: "\(.*\)".*/\1/p' config.yaml)
ADDON_IMAGE_AMD64 ?= $(subst {arch},amd64,$(IMAGE_TEMPLATE))
ADDON_IMAGE_AARCH64 ?= $(subst {arch},aarch64,$(IMAGE_TEMPLATE))

# Build arguments shared by every image build so the local image, the release
# image, and the validator agree on the labels they stamp.
ADDON_BUILD_ARGS := --build-arg BUILD_VERSION=$(VERSION) --build-arg BUILD_REVISION=$(REVISION)

# Compiling apparmor.txt with AppArmor's own parser is the only check that a
# profile the Supervisor rejects never reaches a device, where a broken profile
# stops the add-on from starting.
APPARMOR_IMAGE := esp32-streamline-ha-addon-apparmor
APPARMOR_RUN = $(CONTAINER) run --rm -v "$(CURDIR)/apparmor.txt:/apparmor.txt:ro" $(APPARMOR_IMAGE)

.PHONY: format lint apparmor-image context validate test image publish check

format:
	@true

apparmor-image:
	$(CONTAINER) build -f Dockerfile.apparmor -t $(APPARMOR_IMAGE) .

lint: apparmor-image
	@test "$(BUILD_ARCH)" = "amd64" -o "$(BUILD_ARCH)" = "aarch64" || (echo "BUILD_ARCH must be amd64 or aarch64" >&2; exit 2)
	@test "$(VERSION)" = "$(CONFIG_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(CONFIG_VERSION))" >&2; exit 2)
	@test "$(APPARMOR_PROFILE)" = "$(SLUG)" || (echo "apparmor.txt declares profile '$(APPARMOR_PROFILE)', which the Supervisor ignores; it must match the slug '$(SLUG)'" >&2; exit 2)
	@grep -q 'UV_PROJECT_ENVIRONMENT=/opt/venv' Dockerfile || (echo "apparmor.txt grants the virtual environment at /opt/venv; the Dockerfile no longer builds it there" >&2; exit 2)
	$(APPARMOR_RUN) apparmor_parser --skip-kernel-load --skip-read-cache --warn=all /apparmor.txt

# A standard Home Assistant add-on context: the bridge distribution plus the
# freshly built console asset, config.yaml, and the AppArmor profile the
# Supervisor loads, with no reach into the bridge source tree. This is what
# lets the ecosystem builder consume the add-on unchanged and keeps a build
# from mutating a sibling component.
context:
	$(MAKE) -C ../console build-bridge
	rm -rf $(BUILD_CONTEXT)
	mkdir -p $(BUILD_CONTEXT)/src
	cp Dockerfile config.yaml apparmor.txt $(BUILD_CONTEXT)/
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

# Own the published images end to end: build both architectures with verified
# version/arch/revision labels, write-once push each versioned tag, and print
# every image digest. `PUBLISH_DRY_RUN=1` proves a clean checkout can build and
# stage a publish without a registry or a push. The release workflow calls this
# and holds no add-on Docker details of its own.
publish: lint context
	@set -eu; \
	printf '%s\n%s\n' "amd64 $(ADDON_IMAGE_AMD64) linux/amd64" "aarch64 $(ADDON_IMAGE_AARCH64) linux/arm64" \
		| while read -r arch image platform; do \
		echo "==> $$image:$(VERSION) ($$platform)"; \
		$(CONTAINER) build --platform "$$platform" $(ADDON_BUILD_ARGS) \
			--build-arg BUILD_ARCH="$$arch" -t "$$image:$(VERSION)" $(BUILD_CONTEXT); \
		for pair in \
			"org.opencontainers.image.version=$(VERSION)" \
			"org.opencontainers.image.revision=$(REVISION)" \
			"io.hass.arch=$$arch"; do \
			key="$${pair%%=*}"; want="$${pair#*=}"; \
			got="$$($(CONTAINER) inspect --format "{{index .Config.Labels \"$$key\"}}" "$$image:$(VERSION)")"; \
			test "$$got" = "$$want" || { echo "label $$key is '$$got', expected '$$want'" >&2; exit 1; }; \
		done; \
		if [ -n "$(PUBLISH_DRY_RUN)" ]; then \
			echo "dry-run: built $$image:$(VERSION) ($$($(CONTAINER) inspect --format '{{.Id}}' "$$image:$(VERSION)")), labels verified, push skipped"; \
			continue; \
		fi; \
		if $(CONTAINER) manifest inspect "$$image:$(VERSION)" >/dev/null 2>&1; then \
			echo "$$image:$(VERSION) already published; keeping it"; \
		else \
			$(CONTAINER) push "$$image:$(VERSION)"; \
		fi; \
		digest="$$($(CONTAINER) buildx imagetools inspect "$$image:$(VERSION)" --format '{{.Manifest.Digest}}')"; \
		echo "$$digest" | grep -Eq '^sha256:[0-9a-f]{64}$$'; \
		echo "published $$image@$$digest"; \
	done

check: lint validate test
