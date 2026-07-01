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

.PHONY: check lint test format clean \
	bridge-format bridge-lint bridge-test bridge-check bridge-image bridge-run bridge-up \
	firmware-format firmware-lint firmware-build firmware-test firmware-check firmware-flash firmware-monitor firmware-capture firmware-clean firmware-artifacts \
	analysis-lint analysis-check analysis-capture version-check release

check: lint test

format: bridge-format firmware-format

lint: bridge-lint firmware-lint analysis-lint

test: bridge-test firmware-test firmware-build

# Per-component check aggregates. CI fans out over these by name, so a new
# component becomes CI-covered the moment it has a `<name>-check` target and a
# path filter entry — no workflow job to add.
bridge-check: bridge-lint bridge-test

firmware-check: firmware-lint firmware-test firmware-build

analysis-check: analysis-lint

bridge-format:
	$(MAKE) -C bridge format

bridge-lint:
	$(MAKE) -C bridge lint

bridge-test:
	$(MAKE) -C bridge test

bridge-image:
	$(MAKE) -C bridge image VERSION=$(VERSION)

bridge-run:
	$(MAKE) -C bridge run VERSION=$(VERSION) BRIDGE_ARGS="$(BRIDGE_ARGS)" BRIDGE_PORTS="$(BRIDGE_PORTS)"

bridge-up:
	$(MAKE) -C bridge up VERSION=$(VERSION)

firmware-format:
	$(MAKE) -C firmware format

firmware-lint:
	$(MAKE) -C firmware lint

firmware-build:
	$(MAKE) -C firmware build

firmware-test:
	$(MAKE) -C firmware test

firmware-flash:
	$(MAKE) -C firmware flash PORT=$(PORT)

firmware-monitor:
	$(MAKE) -C firmware monitor PORT=$(PORT)

firmware-capture:
	$(MAKE) -C firmware capture PORT=$(PORT) CAPTURE_SECS=$(CAPTURE_SECS) CAPTURE_ARGS=$(CAPTURE_ARGS)

firmware-clean:
	$(MAKE) -C firmware clean

firmware-artifacts:
	$(MAKE) -C firmware artifacts VERSION=$(VERSION)

analysis-lint:
	$(MAKE) -C tools/analysis lint

analysis-capture:
	$(MAKE) -C tools/analysis capture REF="$(REF)" CAP="$(CAP)"

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(FIRMWARE_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.toml ($(FIRMWARE_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$$' || (echo "VERSION must be a semantic version" >&2; exit 2)

release: version-check check firmware-artifacts bridge-image
