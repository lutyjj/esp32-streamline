# Shared build definitions included by the root and every component Makefile.
# Keep this file free of component knowledge: only cross-cutting values live here.

# Container runtime shared by every component build. Prefer docker, fall back to
# podman, so the same targets work regardless of which is installed. Override
# explicitly with `make CONTAINER=podman ...`.
CONTAINER ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)

# Named volume shared by all Python components for ruff/mypy caches.
PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache

# Named volume for the console's npm download cache.
NPM_CACHE_VOLUME ?= esp32-streamline-npm-cache

# Extract `version = "X.Y.Z"` from a TOML file: $(call toml_version,path/to/file.toml)
toml_version = $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' $(1))
