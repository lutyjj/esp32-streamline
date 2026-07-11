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

# The root Dockerfile keeps the changelog generator pinned and Dependabot-managed.
GIT_CLIFF_IMAGE := esp32-streamline-release-tools
CHANGELOG_FILE := ha-addon/CHANGELOG.md
# Render pending commits under this version instead of "Unreleased" — set it
# during release prep, e.g. `make changelog CHANGELOG_TAG=v0.6.0`.
CHANGELOG_TAG ?=
GIT_COMMON_DIR := $(abspath $(shell git rev-parse --git-common-dir))

# $(call git_cliff,ARGS) runs the pinned generator over the repo as the host
# user, so generated files stay editable and the repo reads as owned (git-cliff
# is pure-Rust and needs no git binary).
git_cliff = $(CONTAINER) run --rm -v "$(REPO_ROOT)":/app -w /app \
	-v "$(GIT_COMMON_DIR):$(GIT_COMMON_DIR)" \
	-u $(shell id -u):$(shell id -g) -e HOME=/tmp $(GIT_CLIFF_IMAGE) $(1)

# Reach the component sub-makes through the environment so the `<component>-%`
# forwarding rules below stay argument-free.
export VERSION PORT CAPTURE_SECS CAPTURE_ARGS BRIDGE_ARGS BRIDGE_PORTS BRIDGE_IMAGE ADDON_IMAGE REF CAP

.PHONY: check help lint test format clean release-tools-image changelog changelog-check release release-prepare release-verify release-notes \
	bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check version-check

check: lint test

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make <c>-check                       c = bridge | console | firmware | tools | webflasher | ha-addon"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash PORT=..., bridge-run, bridge-up"
	@echo "  make changelog[-check] VERSION=X.Y.Z  generate or validate the add-on changelog"
	@echo "  make release VERSION=X.Y.Z           prepare and verify a release snapshot"

format: bridge-format console-format firmware-format tools-format ha-addon-format

release-tools-image:
	$(CONTAINER) build -f Dockerfile.release-tools -t $(GIT_CLIFF_IMAGE) .

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
firmware-check: firmware-lint firmware-test firmware-openapi-check firmware-build ;
tools-check: tools-lint tools-test ;
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
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || (echo "VERSION must be a stable X.Y.Z release version" >&2; exit 2)

# Prepare the only files that carry the product version, then regenerate the
# add-on metadata from the same git history the published release will use.
# Start clean so the release commit contains no unrelated work.
release-prepare:
	@test -z "$$(git status --porcelain)" || (echo "release preparation requires a clean worktree" >&2; exit 2)
	$(MAKE) tools-release-prepare VERSION=$(VERSION)
	$(MAKE) changelog CHANGELOG_TAG=v$(VERSION)
	$(MAKE) version-check VERSION=$(VERSION)
	$(MAKE) changelog-check VERSION=$(VERSION)

# Verify a prepared release without changing its files. The tag workflow and
# release-promotion workflow both use this target against a fixed commit.
release-verify: changelog-check check firmware-artifacts bridge-image
	$(MAKE) ha-addon-image BUILD_ARCH=aarch64 VERSION=$(VERSION)
	$(MAKE) ha-addon-image BUILD_ARCH=amd64 VERSION=$(VERSION)

# A local release command leaves a complete, validated release snapshot ready
# for review. Publishing remains a separate, protected CI action.
release: release-prepare
	$(MAKE) release-verify VERSION=$(VERSION)

# Regenerate ha-addon/CHANGELOG.md from Conventional Commits. During release
# prep (after the version bump, before tagging) pass CHANGELOG_TAG=vX.Y.Z so the
# new commits land under that version instead of "Unreleased".
changelog: release-tools-image
	$(call git_cliff,$(if $(CHANGELOG_TAG),--tag $(CHANGELOG_TAG) )--output $(CHANGELOG_FILE))

# The versioned release commit carries the exact add-on changelog that
# Supervisor will render. Render the same tag into stdout and compare it
# without changing the working tree.
changelog-check: release-tools-image version-check
	@$(call git_cliff,--tag v$(VERSION)) | diff -u "$(CHANGELOG_FILE)" - || { \
		status=$$?; \
		if [ "$$status" -eq 1 ]; then \
			echo "$(CHANGELOG_FILE) does not match git-cliff for v$(VERSION)." >&2; \
			echo "Run 'make changelog CHANGELOG_TAG=v$(VERSION)' and commit the result." >&2; \
		fi; \
		exit "$$status"; \
	}

# Print the newest release's notes only (no header/footer) for the GitHub
# release body. The release workflow feeds this to `gh release create`.
release-notes: release-tools-image
	@$(call git_cliff,--latest --strip all)
