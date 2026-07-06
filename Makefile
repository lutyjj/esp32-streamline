include mk/common.mk

PROJECT_VERSION := $(call toml_version,bridge/pyproject.toml)
FIRMWARE_VERSION := $(call toml_version,firmware/streamline/Cargo.toml)
ADDON_VERSION := $(shell sed -n 's/^version: "\([^"]*\)"/\1/p' ha-addon/config.yaml)
VERSION ?= $(PROJECT_VERSION)
PORT ?= /dev/cu.usbserial-0001
CAPTURE_SECS ?= 20
CAPTURE_ARGS ?=
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088
BRIDGE_IMAGE ?=
ADDON_IMAGE ?=
REF ?=
CAP ?=

# Reach the component sub-makes through the environment so the `<component>-%`
# forwarding rules below stay argument-free.
export VERSION PORT CAPTURE_SECS CAPTURE_ARGS BRIDGE_ARGS BRIDGE_PORTS BRIDGE_IMAGE ADDON_IMAGE REF CAP

.PHONY: check help lint test format clean \
	bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check version-check release

check: lint test

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make <c>-check                       c = bridge | console | firmware | tools | webflasher | ha-addon"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash PORT=..., bridge-run, bridge-up"
	@echo "  make release VERSION=X.Y.Z           build local release deliverables"

format: bridge-format console-format firmware-format tools-format ha-addon-format

lint: bridge-lint console-lint firmware-lint tools-lint webflasher-lint ha-addon-lint

test: bridge-test console-test firmware-test firmware-build ha-addon-test

# Only the firmware writes build artifacts onto the host; every other component
# builds inside containers and leaves nothing to clean.
clean: firmware-clean

# Per-component check aggregates. The trailing `;` gives each an empty recipe so
# the `<component>-%` forwarding rules do not also fire a `check` sub-target. CI
# fans out over these by name.
bridge-check: bridge-lint bridge-test bridge-image ;
console-check: console-lint console-test console-build ;
firmware-check: firmware-lint firmware-test firmware-build ;
tools-check: tools-lint ;
webflasher-check: webflasher-lint ;
ha-addon-check: ha-addon-lint ha-addon-test ;

# Forward any `<component>-<verb>` to that component's Makefile. Pass-through
# variables reach the sub-make through `export` above.
bridge-%:
	$(MAKE) -C bridge $*

console-%:
	$(MAKE) -C console $*

firmware-%:
	$(MAKE) -C firmware $*

tools-%:
	$(MAKE) -C tools $*

webflasher-%:
	$(MAKE) -C webflasher $*

ha-addon-%:
	$(MAKE) -C ha-addon $*

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(FIRMWARE_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.toml ($(FIRMWARE_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(ADDON_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(ADDON_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$$' || (echo "VERSION must be a semantic version" >&2; exit 2)

release: version-check check firmware-artifacts bridge-image ha-addon-image
