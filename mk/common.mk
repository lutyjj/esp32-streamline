# Cross-cutting values for the root and component Makefiles; no component knowledge.

CONTAINER ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)

# $(call dotenv,NAME) reads one value from the gitignored root .env (see .env.example).
# One read per value, so make-hostile characters in a secret cannot break parsing.
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))..)
dotenv = $(shell sed -n 's/^$(1)=//p' $(REPO_ROOT)/.env 2>/dev/null)

# Runs as the caller with a disposable home and the checkout mounted read-only.
CONTAINER_HOST_USER ?= $(shell id -u):$(shell id -g)
CONTAINER_SAFE_HOME ?= /tmp
READONLY_REPO_RUN = $(CONTAINER) run --rm --user "$(CONTAINER_HOST_USER)" \
	--env HOME="$(CONTAINER_SAFE_HOME)" --volume "$(REPO_ROOT):/repo:ro" --workdir /repo

PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache

# Extract `version = "X.Y.Z"` from a TOML file: $(call toml_version,path/to/file.toml)
toml_version = $(shell sed -n 's/^version = "\([^"]*\)".*/\1/p' $(1))
