include mk/common.mk

PROJECT_VERSION := $(call toml_version,bridge/pyproject.toml)
FIRMWARE_VERSION := $(call toml_version,firmware/streamline/Cargo.toml)
FIRMWARE_LOCK_VERSION := $(shell awk '\
  /^\[\[package\]\]$$/ { package = 0 } \
  /^name = "streamline-firmware"$$/ { package = 1; next } \
  package && /^version = "/ { split($$0, fields, "\""); print fields[2]; exit }' firmware/streamline/Cargo.lock)
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

# Repository checks use maintained linters in pinned public containers. The
# version tag names the tool and the digest fixes the supplied image.
ACTIONLINT_IMAGE := rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
LYCHEE_IMAGE := lycheeverse/lychee:0.24.2@sha256:e2d19e57cf6ab037026f20b8e449a1f30d9d7f81eef4194763aab2eab20bd28d
MARKDOWNLINT_IMAGE := ghcr.io/igorshubovych/markdownlint-cli:v0.49.0@sha256:ac8605cdc57270579cc445fdc389bcab0ed9401b80b4770e90c05af7199dd40f
YQ_IMAGE := mikefarah/yq:4.53.3@sha256:11a1f0b604b13dbbdc662260d8db6f644b22d8553122a25c1b5b2e8713ca6977
GITLEAKS_IMAGE := zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

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

.PHONY: check help lint test format clean release-tools-image changelog changelog-check release release-history release-prepare release-lock-check release-check release-verify release-package release-notes \
	bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check repository-check docs-check api-contract-check version-check

check: bridge-check console-check firmware-check tools-check webflasher-check ha-addon-check repository-check

help:
	@echo "Cross-project targets:"
	@echo "  make lint | test | check | format   run across every component"
	@echo "  make <c>-check                       c = bridge | console | firmware | tools | webflasher | ha-addon"
	@echo "  make <c>-<verb>                       forward <verb> to that component's Makefile,"
	@echo "                                        e.g. firmware-flash PORT=..., bridge-run, bridge-up"
	@echo "  make repository-check                  validate docs, repository metadata, and release versions"
	@echo "  make changelog[-check] VERSION=X.Y.Z  generate or validate the add-on changelog"
	@echo "  make release-lock-check VERSION=X.Y.Z validate release-owned lockfiles"
	@echo "  make release VERSION=X.Y.Z           prepare and verify a release snapshot"
	@echo "  make release-package VERSION=X.Y.Z   build verified release assets for publishing"

format: bridge-format console-format firmware-format tools-format ha-addon-format

release-tools-image:
	$(CONTAINER) build -f Dockerfile.release-tools -t $(GIT_CLIFF_IMAGE) .

lint: bridge-lint console-lint firmware-lint tools-lint webflasher-lint ha-addon-lint

test: bridge-test console-test firmware-test firmware-build tools-test ha-addon-test

# Only the firmware writes build artifacts onto the host; every other component
# builds inside containers and leaves nothing to clean.
clean: firmware-clean

# Per-component check aggregates. The trailing `;` gives each an empty recipe so
# the `<component>-%` forwarding rules do not also fire a `check` sub-target. CI
# fans out over these by name.
bridge-check: bridge-lock-check bridge-lint bridge-test bridge-openapi-check bridge-image ;
console-check: console-lint console-test console-build ;
firmware-check: firmware-lock-check firmware-lint firmware-test firmware-openapi-check firmware-build ;
tools-check: tools-lock-check tools-lint tools-test tools-image tools-qemu-image ;
webflasher-check: webflasher-lint ;
ha-addon-check: ha-addon-lint ha-addon-test ;
repository-check: version-check
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(ACTIONLINT_IMAGE) -color
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(MARKDOWNLINT_IMAGE) --config /repo/.markdownlint.json README.md CONTRIBUTING.md AGENTS.md SECURITY.md docs
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(LYCHEE_IMAGE) --config /repo/lychee.toml /repo
	$(CONTAINER) run --rm --entrypoint sh -v "$(REPO_ROOT):/repo:ro" -w /repo $(YQ_IMAGE) -ec 'find .github -type f \( -name "*.yml" -o -name "*.yaml" \) -exec yq eval --exit-status "." {} \; >/dev/null; yq eval --exit-status "." repository.yaml >/dev/null; find docs -type f -name "*.json" -exec yq eval --exit-status "." {} \; >/dev/null'
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) dir /repo/docs --no-banner --redact
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) dir /repo/README.md --no-banner --redact
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) dir /repo/CONTRIBUTING.md --no-banner --redact
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) dir /repo/AGENTS.md --no-banner --redact
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" -w /repo $(GITLEAKS_IMAGE) dir /repo/SECURITY.md --no-banner --redact
	@test -z "$$(git grep -n 'actions/cache' -- .github/workflows)" || (echo "firmware cache actions belong in .github/actions/firmware-cache" >&2; exit 1)
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

# Prepare the only files that carry the product version, then regenerate the
# add-on metadata from the same git history the published release will use.
# Start clean so the release commit contains no unrelated work.
release-history:
	@remote="$$(git remote | sed -n '1p')"; \
		test -n "$$remote" || { echo "a git remote is required for release history" >&2; exit 2; }; \
		git fetch --quiet --force --prune --prune-tags "$$remote" '+refs/tags/*:refs/tags/*'

release-prepare: release-history
	@test -z "$$(git status --porcelain)" || (echo "release preparation requires a clean worktree" >&2; exit 2)
	$(MAKE) tools-release-prepare VERSION=$(VERSION)
	$(MAKE) bridge-lock
	$(MAKE) release-lock-check VERSION=$(VERSION)
	$(MAKE) changelog CHANGELOG_TAG=v$(VERSION)
	$(MAKE) version-check VERSION=$(VERSION)
	$(MAKE) changelog-check VERSION=$(VERSION)

# A release version changes the bridge package metadata, which uv records in
# bridge/uv.lock. Cargo.lock carries the firmware package version directly.
release-lock-check: version-check bridge-lock-check firmware-lock-check ;

# Run all release checks without compiling the firmware twice: the artifact
# target below performs the cross build that ordinary `make test` would do.
release-check: lint bridge-test console-test firmware-test ha-addon-test

# Verify a prepared release without changing its files. Release PRs and
# promotion use this target against a fixed commit.
release-verify: changelog-check release-lock-check release-check firmware-artifacts bridge-image
	$(MAKE) ha-addon-image BUILD_ARCH=aarch64 VERSION=$(VERSION)
	$(MAKE) ha-addon-image BUILD_ARCH=amd64 VERSION=$(VERSION)

# Promotion verifies this exact commit before publishing. Publishing needs the
# distributable firmware and bridge image; Buildx publishes the two add-on
# images directly in the release workflow.
release-package: changelog-check release-lock-check firmware-artifacts bridge-image

# A local release command leaves a complete, validated release snapshot ready
# for review. Publishing remains a separate, protected CI action.
release: release-prepare
	$(MAKE) release-verify VERSION=$(VERSION)

# Regenerate ha-addon/CHANGELOG.md from Conventional Commits. During release
# prep (after the version bump, before tagging) pass CHANGELOG_TAG=vX.Y.Z so the
# new commits land under that version instead of "Unreleased".
changelog: release-history release-tools-image
	$(call git_cliff,$(if $(CHANGELOG_TAG),--tag $(CHANGELOG_TAG) )--output $(CHANGELOG_FILE))

# The versioned release commit carries the exact add-on changelog that
# Supervisor will render. Render the same tag into stdout and compare it
# without changing the working tree.
changelog-check: release-history release-tools-image version-check
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
release-notes: release-history release-tools-image
	@$(call git_cliff,--latest --strip all)
