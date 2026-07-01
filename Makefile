PROJECT_VERSION := $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' bridge/pyproject.toml)
FIRMWARE_VERSION := $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' firmware/streamline/Cargo.toml)
VERSION ?= $(PROJECT_VERSION)
PORT ?= /dev/cu.usbserial-0001
CAPTURE_SECS ?= 20
CAPTURE_ARGS ?=
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088
REF ?=
CAP ?=

# Reach the component sub-makes through the environment so the `<component>-%`
# forwarding rules below stay argument-free.
export VERSION PORT CAPTURE_SECS CAPTURE_ARGS BRIDGE_ARGS BRIDGE_PORTS REF CAP

.PHONY: check help lint test format clean \
	bridge-check firmware-check analysis-check version-check release

check: lint test

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make <c>-check                       c = bridge | firmware | analysis"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash PORT=..., bridge-run, bridge-up"
	@echo "  make release VERSION=X.Y.Z           build local release deliverables"

format: bridge-format firmware-format

lint: bridge-lint firmware-lint analysis-lint

test: bridge-test firmware-test firmware-build

# Per-component check aggregates. The trailing `;` gives each an empty recipe so
# the `<component>-%` forwarding rules do not also fire a `check` sub-target. CI
# fans out over these by name.
bridge-check: bridge-lint bridge-test ;
firmware-check: firmware-lint firmware-test firmware-build ;
analysis-check: analysis-lint ;

# Forward any `<component>-<verb>` to that component's Makefile. Pass-through
# variables reach the sub-make through `export` above.
bridge-%:
	$(MAKE) -C bridge $*

firmware-%:
	$(MAKE) -C firmware $*

analysis-%:
	$(MAKE) -C tools/analysis $*

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(FIRMWARE_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.toml ($(FIRMWARE_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$$' || (echo "VERSION must be a semantic version" >&2; exit 2)

release: version-check check firmware-artifacts bridge-image
