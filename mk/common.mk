# Shared build definitions included by the root and every component Makefile.
# Keep this file free of component knowledge: only cross-cutting values live here.

# Container runtime shared by every component build. Prefer docker, fall back to
# podman, so the same targets work regardless of which is installed. Override
# explicitly with `make CONTAINER=podman ...`.
CONTAINER ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)

# Read one variable from the gitignored root .env — the store for local lab
# values (see .env.example): $(call dotenv,STREAMLINE_DEVICE). Values are read
# individually so a secret with make-hostile characters cannot break parsing.
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))..)
dotenv = $(shell sed -n 's/^$(1)=//p' $(REPO_ROOT)/.env 2>/dev/null)

# Read-only repository tools run as the caller with a disposable home. The
# parameter is the checkout to mount, which lets the repository contract test
# exercise paths whose parents are not world-readable.
CONTAINER_HOST_USER ?= $(shell id -u):$(shell id -g)
CONTAINER_SAFE_HOME ?= /tmp
container_readonly = $(CONTAINER) run --rm --user "$(CONTAINER_HOST_USER)" \
	--env HOME="$(CONTAINER_SAFE_HOME)" --volume "$(1):/repo:ro" --workdir /repo
READONLY_REPO_RUN = $(call container_readonly,$(REPO_ROOT))

# Published images identify the exact source commit they contain.
REVISION ?= $(shell git -C "$(REPO_ROOT)" rev-parse HEAD)

# Named volume shared by all Python components for ruff/mypy caches.
PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache

# Extract `version = "X.Y.Z"` from a TOML file: $(call toml_version,path/to/file.toml)
toml_version = $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' $(1))
