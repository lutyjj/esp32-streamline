include mk/common.mk

PROJECT_VERSION := $(call toml_version,bridge/pyproject.toml)
FIRMWARE_VERSION := $(call toml_version,firmware/streamline/Cargo.toml)
FIRMWARE_LOCK_VERSION := $(shell awk '\
  /^\[\[package\]\]$$/ { package = 0 } \
  /^name = "streamline-firmware"$$/ { package = 1; next } \
  package && /^version = "/ { split($$0, fields, "\""); print fields[2]; exit }' firmware/streamline/Cargo.lock)
ADDON_VERSION := $(shell sed -n 's/^version: "\([^"]*\)".*/\1/p' ha-addon/config.yaml)
VERSION ?= $(PROJECT_VERSION)

# Each pin is a named stage in .github/tool-images.Dockerfile, where Dependabot updates it.
TOOL_IMAGES := $(REPO_ROOT)/.github/tool-images.Dockerfile
tool_image = $(or $(shell sed -n 's/^FROM \([^ ]*\) AS $(1)$$/\1/p' $(TOOL_IMAGES)),$(error no '$(1)' stage in $(TOOL_IMAGES)))
ACTIONLINT_IMAGE := $(call tool_image,actionlint)
LYCHEE_IMAGE := $(call tool_image,lychee)
MARKDOWNLINT_IMAGE := $(call tool_image,markdownlint)
YQ_IMAGE := $(call tool_image,yq)
GITLEAKS_IMAGE := $(call tool_image,gitleaks)
OSV_SCANNER_IMAGE := $(call tool_image,osv-scanner)
NIX_IMAGE := $(call tool_image,nix)

# Command-line variables such as FEATURES already reach sub-makes through MAKEFLAGS.
export VERSION

.PHONY: check help lint test format clean smoke-qemu \
	bridge-check console-check firmware-check tools-check ha-addon-check repository-check repository-secret-check repository-dependency-audit repository-nix-check docs-check api-contract-check version-check

check: bridge-check console-check firmware-check tools-check ha-addon-check repository-check

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make smoke-qemu                      build QEMU images and smoke the emulated device"
	@echo "  make <c>-check                       c = bridge | console | firmware | tools | ha-addon"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash, bridge-run, bridge-up"
	@echo "  make repository-check                  validate docs, metadata, the Nix shell, release versions, and dependency advisories"
	@echo "  make version-check VERSION=X.Y.Z     require one version across the release-owned files"

format: bridge-format console-format firmware-format tools-format ha-addon-format

lint: bridge-lint console-lint firmware-lint tools-lint ha-addon-lint

test: bridge-test console-test firmware-test firmware-build tools-test ha-addon-test

# Kept out of `make test`: it builds firmware images and boots an emulator.
smoke-qemu:
	$(MAKE) firmware-qemu-artifacts
	$(MAKE) tools-smoke-qemu

# Only the firmware leaves build artifacts on the host.
clean: firmware-clean

# The trailing `;` gives each an empty recipe, so the `<component>-%` rules do not
# also run a `check` sub-target.
bridge-check: bridge-lock-check bridge-lint bridge-test bridge-openapi-check bridge-image ;
console-check: console-lint console-test console-build ;
firmware-check: firmware-lock-check firmware-lint firmware-test firmware-openapi-check firmware-ota-size-self-test firmware-build ;
tools-check: tools-lock-check tools-lint tools-test tools-image tools-qemu-image ;
ha-addon-check: ha-addon-lint ha-addon-test ha-addon-apparmor-test ;
repository-check: version-check repository-secret-check repository-dependency-audit repository-nix-check
	$(READONLY_REPO_RUN) $(ACTIONLINT_IMAGE) -color
	$(READONLY_REPO_RUN) $(MARKDOWNLINT_IMAGE) --config /repo/.markdownlint.json README.md CONTRIBUTING.md AGENTS.md SECURITY.md docs firmware/streamline/README.md ha-addon/DOCS.md ha-addon/README.md tools/README.md
	$(READONLY_REPO_RUN) $(LYCHEE_IMAGE) --config /repo/lychee.toml /repo
	$(READONLY_REPO_RUN) --entrypoint sh $(YQ_IMAGE) -ec 'find .github -type f \( -name "*.yml" -o -name "*.yaml" \) -exec yq eval "." {} + >/dev/null; yq eval --exit-status "." repository.yaml >/dev/null; find docs -type f -name "*.json" -exec yq eval "." {} + >/dev/null'
	@test -z "$$(git grep -n 'actions/cache' -- .github/workflows)" || (echo "firmware cache actions belong in .github/actions/firmware-cache" >&2; exit 1)

# New lockfiles join the scan unregistered; osv-scanner.toml holds accepted
# advisories, each with a reason and an expiry.
repository-dependency-audit:
	$(READONLY_REPO_RUN) $(OSV_SCANNER_IMAGE) scan source --config /repo/osv-scanner.toml --recursive /repo

# Only flake.nix and flake.lock enter the container, so local state cannot change the result.
repository-nix-check:
	@tar -C "$(REPO_ROOT)" -cf - flake.nix flake.lock | \
		$(CONTAINER) run --rm -i --entrypoint sh \
			--env NIX_CONFIG="extra-experimental-features = nix-command flakes" \
			$(NIX_IMAGE) -ec 'mkdir /flake; tar -xf - -C /flake; exec nix flake check --all-systems --no-update-lock-file path:/flake'

# Scans tracked files in a tmpfs, so .env and build outputs never enter the container.
repository-secret-check:
	@git ls-files -z | tar -C "$(REPO_ROOT)" --null -T - -cf - | \
		$(CONTAINER) run --rm -i --user "$(CONTAINER_HOST_USER)" --env HOME="$(CONTAINER_SAFE_HOME)" --entrypoint sh \
			--tmpfs /scan:rw,noexec,nosuid,size=16m,mode=1777 \
			$(GITLEAKS_IMAGE) -ec 'tar -xf - -C /scan; exec gitleaks dir /scan --no-banner --no-color --redact'

docs-check: repository-check ;
api-contract-check: firmware-openapi-check console-lint ;

# Forward any `<component>-<verb>` to that component's Makefile.
bridge-%:
	$(MAKE) -C bridge $*

console-%:
	$(MAKE) -C console $*

firmware-%:
	$(MAKE) -C firmware $*

tools-%:
	$(MAKE) -C tools $*

ha-addon-%:
	$(MAKE) -C ha-addon $*

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(FIRMWARE_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.toml ($(FIRMWARE_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(FIRMWARE_LOCK_VERSION)" || (echo "VERSION=$(VERSION) does not match firmware/streamline/Cargo.lock ($(FIRMWARE_LOCK_VERSION))" >&2; exit 2)
	@test "$(VERSION)" = "$(ADDON_VERSION)" || (echo "VERSION=$(VERSION) does not match ha-addon/config.yaml ($(ADDON_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || (echo "VERSION must be a stable X.Y.Z release version" >&2; exit 2)

