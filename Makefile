include mk/common.mk

PROJECT_VERSION := $(call toml_version,bridge/pyproject.toml)
FIRMWARE_VERSION := $(call toml_version,firmware/streamline/Cargo.toml)
FIRMWARE_LOCK_VERSION := $(shell awk '\
  /^\[\[package\]\]$$/ { package = 0 } \
  /^name = "streamline-firmware"$$/ { package = 1; next } \
  package && /^version = "/ { split($$0, fields, "\""); print fields[2]; exit }' firmware/streamline/Cargo.lock)
ADDON_VERSION := $(shell sed -n 's/^version: "\([^"]*\)".*/\1/p' ha-addon/config.yaml)
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

# Repository checks use maintained linters in pinned public containers. The
# version tag names the tool and the digest fixes the supplied image.
ACTIONLINT_IMAGE := rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
LYCHEE_IMAGE := lycheeverse/lychee:0.24.2@sha256:e2d19e57cf6ab037026f20b8e449a1f30d9d7f81eef4194763aab2eab20bd28d
MARKDOWNLINT_IMAGE := ghcr.io/igorshubovych/markdownlint-cli:v0.49.0@sha256:ac8605cdc57270579cc445fdc389bcab0ed9401b80b4770e90c05af7199dd40f
YQ_IMAGE := mikefarah/yq:4.53.3@sha256:11a1f0b604b13dbbdc662260d8db6f644b22d8553122a25c1b5b2e8713ca6977
GITLEAKS_IMAGE := zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
OSV_SCANNER_IMAGE := ghcr.io/google/osv-scanner:v2.4.0@sha256:5116601dedc01c1c580eb92371883ec052fc4c13c3fbc109d621a63ac416d475

# Reach the component sub-makes through the environment so the `<component>-%`
# forwarding rules below stay argument-free.
export VERSION PORT CAPTURE_SECS CAPTURE_ARGS BRIDGE_ARGS BRIDGE_PORTS BRIDGE_IMAGE ADDON_IMAGE REF CAP

.PHONY: check help lint test format clean smoke-qemu \
	bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check repository-check repository-container-contract repository-secret-check repository-secret-scanner-self-test repository-dependency-audit docs-check api-contract-check version-check

check: bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check repository-check

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make smoke-qemu                      build QEMU images and smoke the emulated device"
	@echo "  make <c>-check                       c = bridge | console | firmware | tools | webflasher | ha-addon"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash PORT=..., bridge-run, bridge-up"
	@echo "  make repository-check                  validate docs, metadata, release versions, and dependency advisories"
	@echo "  make version-check VERSION=X.Y.Z     require one version across the release-owned files"

format: bridge-format console-format firmware-format tools-format ha-addon-format

lint: bridge-lint console-lint firmware-lint tools-lint webflasher-lint ha-addon-lint

test: bridge-test console-test firmware-test firmware-build tools-test ha-addon-test

# One command to smoke the firmware pre-silicon: build the QEMU variant images,
# then boot the emulated device and run the device suite against it. The same
# suite runs on a real board with `make tools-smoke-device DEVICE=...`; CI runs
# this suite in the dedicated qemu-smoke job. Kept out of `make test` because it
# builds firmware images and boots an emulator — too heavy for the fast fan-out.
smoke-qemu:
	$(MAKE) firmware-qemu-artifacts
	$(MAKE) tools-smoke-qemu

# Only the firmware writes build artifacts onto the host; every other component
# builds inside containers and leaves nothing to clean.
clean: firmware-clean

# Per-component check aggregates. The trailing `;` gives each an empty recipe so
# the `<component>-%` forwarding rules do not also fire a `check` sub-target. CI
# fans out over these by name.
bridge-check: bridge-lock-check bridge-lint bridge-test bridge-openapi-check bridge-image ;
console-check: console-lint console-test console-build ;
firmware-check: firmware-lock-check firmware-lint firmware-test firmware-openapi-check firmware-ota-size-self-test firmware-build ;
tools-check: tools-lock-check tools-lint tools-test tools-image tools-qemu-image ;
webflasher-check: webflasher-lint ;
ha-addon-check: ha-addon-lint ha-addon-validate ha-addon-test ;
repository-check: version-check repository-container-contract repository-secret-check repository-dependency-audit
	$(READONLY_REPO_RUN) $(ACTIONLINT_IMAGE) -color
	$(READONLY_REPO_RUN) $(MARKDOWNLINT_IMAGE) --config /repo/.markdownlint.json README.md CONTRIBUTING.md AGENTS.md SECURITY.md docs firmware/streamline/README.md ha-addon/DOCS.md ha-addon/README.md tools/README.md
	$(READONLY_REPO_RUN) $(LYCHEE_IMAGE) --config /repo/lychee.toml /repo
	$(READONLY_REPO_RUN) --entrypoint sh $(YQ_IMAGE) -ec 'find .github -type f \( -name "*.yml" -o -name "*.yaml" \) -exec yq eval --exit-status "." {} \; >/dev/null; yq eval --exit-status "." repository.yaml >/dev/null; find docs -type f -name "*.json" -exec yq eval --exit-status "." {} \; >/dev/null'
	@test -z "$$(git grep -n 'actions/cache' -- .github/workflows)" || (echo "firmware cache actions belong in .github/actions/firmware-cache" >&2; exit 1)

# Fail on known advisories in any committed lockfile. The recursive scan
# respects .gitignore, so a new component's lockfile joins the audit without
# registration; accepted advisories live in osv-scanner.toml, each with a
# reason and an expiry date.
repository-dependency-audit:
	$(READONLY_REPO_RUN) $(OSV_SCANNER_IMAGE) scan source --config /repo/osv-scanner.toml --recursive /repo

# Prove the shared runner works from a checkout hidden behind a mode-0700
# parent and cannot modify its repository mount.
repository-container-contract:
	@set -eu; \
		fixture="$$(mktemp -d /tmp/streamline-repository-check.XXXXXX)"; \
		trap 'rm -rf "$$fixture"' EXIT INT TERM; \
		chmod 700 "$$fixture"; \
		mkdir -p "$$fixture/.git" "$$fixture/.github/workflows" "$$fixture/docs"; \
		printf '%s\n' 'name: Fixture' 'on: [push]' 'jobs:' '  check:' '    runs-on: ubuntu-latest' '    steps:' '      - run: "true"' > "$$fixture/.github/workflows/fixture.yml"; \
		printf '%s\n' '{}' > "$$fixture/.markdownlint.json"; \
		printf '%s\n' '# Fixture' > "$$fixture/README.md"; \
		printf '%s\n' '{}' > "$$fixture/docs/contract.json"; \
		before="$$(find "$$fixture" -type f -exec sha256sum {} + | LC_ALL=C sort)"; \
		$(call container_readonly,$$fixture) $(ACTIONLINT_IMAGE) -color; \
		$(call container_readonly,$$fixture) $(MARKDOWNLINT_IMAGE) --config /repo/.markdownlint.json README.md; \
		$(call container_readonly,$$fixture) $(LYCHEE_IMAGE) /repo; \
		$(call container_readonly,$$fixture) --entrypoint sh $(YQ_IMAGE) -ec 'yq eval --exit-status "." .github/workflows/fixture.yml >/dev/null; yq eval --exit-status "." docs/contract.json >/dev/null; ! touch /repo/write-probe 2>/dev/null'; \
		$(call container_readonly,$$fixture) $(GITLEAKS_IMAGE) dir /repo --no-banner --redact; \
		after="$$(find "$$fixture" -type f -exec sha256sum {} + | LC_ALL=C sort)"; \
		test "$$after" = "$$before"

# Scan the current contents of every tracked path without mounting ignored local
# files such as .env or generated build outputs. The tmpfs is destroyed with the
# container, so the check leaves neither credentials nor artifacts on the host.
repository-secret-check: repository-secret-scanner-self-test
	@git ls-files -z | tar -C "$(REPO_ROOT)" --null -T - -cf - | \
		$(CONTAINER) run --rm -i --user "$(CONTAINER_HOST_USER)" --env HOME="$(CONTAINER_SAFE_HOME)" --entrypoint sh \
			--tmpfs /scan:rw,noexec,nosuid,size=16m,mode=1777 \
			$(GITLEAKS_IMAGE) -ec 'tar -xf - -C /scan; exec gitleaks dir /scan --no-banner --no-color --redact'

# Prove the pinned scanner still rejects a representative provider credential.
# Split the synthetic value in this recipe so the repository scan does not need
# an allowlist for its own canary.
repository-secret-scanner-self-test:
	@$(CONTAINER) run --rm --user "$(CONTAINER_HOST_USER)" --env HOME="$(CONTAINER_SAFE_HOME)" --entrypoint sh \
		--tmpfs /scan:rw,noexec,nosuid,size=1m,mode=1777 \
		$(GITLEAKS_IMAGE) -ec 'printf "%s%s\n" "AKIA" "QWERTYUIOPASDFGH" > /scan/canary; \
			set +e; gitleaks dir /scan --no-banner --no-color --redact >/dev/null 2>&1; status=$$?; set -e; \
			test "$$status" -eq 1'
docs-check: repository-check ;
api-contract-check: firmware-openapi-check console-lint ;

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
	@test "$(VERSION)" = "$(FIRMWARE_LOCK_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.lock ($(FIRMWARE_LOCK_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(ADDON_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(ADDON_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || (echo "VERSION must be a stable X.Y.Z release version" >&2; exit 2)

