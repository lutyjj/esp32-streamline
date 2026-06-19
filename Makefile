PROJECT_VERSION := $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' bridge/pyproject.toml)
VERSION ?= $(PROJECT_VERSION)
FIRMWARE_TARGET ?= codec-scan
PORT ?= /dev/cu.usbserial-0001
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088
REF ?=
CAP ?=

.PHONY: check lint test format clean \
	bridge-format bridge-lint bridge-test bridge-image bridge-run bridge-up \
	firmware-format firmware-lint firmware-build firmware-streamline firmware-audio-level firmware-codec-scan firmware-flash firmware-flash-full firmware-monitor firmware-clean firmware-artifacts \
	analysis-lint analysis-capture \
	version-check release

check: lint test

format: bridge-format firmware-format

lint: bridge-lint firmware-lint analysis-lint

test: bridge-test firmware-codec-scan firmware-audio-level firmware-streamline

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
	$(MAKE) -C firmware build TARGET=$(FIRMWARE_TARGET) VERSION=$(VERSION)

firmware-streamline:
	$(MAKE) -C firmware build TARGET=streamline VERSION=$(VERSION)

firmware-audio-level:
	$(MAKE) -C firmware build TARGET=audio-level VERSION=$(VERSION)

firmware-codec-scan:
	$(MAKE) -C firmware build TARGET=codec-scan VERSION=$(VERSION)

firmware-flash:
	$(MAKE) -C firmware flash TARGET=$(FIRMWARE_TARGET) PORT=$(PORT)

firmware-flash-full:
	$(MAKE) -C firmware flash-full VERSION=$(VERSION) PORT=$(PORT)

firmware-monitor:
	$(MAKE) -C firmware monitor PORT=$(PORT)

firmware-clean:
	$(MAKE) -C firmware clean TARGET=$(FIRMWARE_TARGET)

firmware-artifacts:
	$(MAKE) -C firmware artifacts VERSION=$(VERSION)

analysis-lint:
	$(MAKE) -C tools/analysis lint

analysis-capture:
	$(MAKE) -C tools/analysis capture REF="$(REF)" CAP="$(CAP)"

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$$' || (echo "VERSION must be a semantic version" >&2; exit 2)

release: version-check check firmware-artifacts bridge-image

clean: firmware-clean
