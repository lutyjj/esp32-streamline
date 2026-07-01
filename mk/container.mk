# Container runtime shared by every component build. Prefer docker, fall back to
# podman, so the same targets work regardless of which is installed. Override
# explicitly with `make CONTAINER=podman ...`.
CONTAINER ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)
