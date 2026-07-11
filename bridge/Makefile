include ../mk/common.mk

DEV_IMAGE := esp32-streamline-bridge-dev
UV_IMAGE := esp32-streamline-bridge-uv
# The release flow injects the published name as BRIDGE_IMAGE; local builds
# fall back to the plain name. `:=` keeps stray IMAGE environment variables out.
IMAGE := $(or $(BRIDGE_IMAGE),esp32-streamline-bridge)
VERSION ?= $(call toml_version,pyproject.toml)
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088

# Run a check in the dev image with the source mounted and the shared ruff/mypy
# cache volume attached.
CONTAINER_RUN := $(CONTAINER) run --rm \
	-v "$(CURDIR):/workspace" -v "$(CURDIR)/..:/repo:ro" -v "$(PYTHON_CACHE_VOLUME):/cache" \
	-e RUFF_CACHE_DIR=/cache/ruff -e MYPY_CACHE_DIR=/cache/mypy \
	-e STREAMLINE_ADDON_CONFIG=/repo/ha-addon/config.yaml \
	-w /workspace $(DEV_IMAGE)
UV_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-e UV_CACHE_DIR=/workspace/.cache/uv -v "$(CURDIR):/workspace" -w /workspace $(UV_IMAGE) uv

.PHONY: uv-image dev-image format lint lock lock-check test image run up

uv-image:
	$(CONTAINER) build --target uv -t $(UV_IMAGE) .

lock: uv-image
	$(UV_RUN) lock --upgrade

lock-check: uv-image
	$(UV_RUN) lock --check

dev-image: lock-check
	$(CONTAINER) build -f Dockerfile.dev -t $(DEV_IMAGE) .

format: dev-image
	$(CONTAINER_RUN) sh -c 'ruff check --select I --fix src tests && ruff format src tests'

lint: dev-image
	$(CONTAINER_RUN) sh -c 'ruff format --check src tests && ruff check src tests && mypy'

test: dev-image
	$(CONTAINER_RUN) sh -c 'PYTHONPATH=/workspace/src python3 -m unittest discover -s tests -v'

image: lock-check
	$(CONTAINER) build -f Dockerfile --build-arg VERSION=$(VERSION) -t $(IMAGE):$(VERSION) .

run: image
	$(CONTAINER) run --rm $(BRIDGE_PORTS) $(IMAGE):$(VERSION) $(BRIDGE_ARGS)

up:
	STREAMLINE_VERSION=$(VERSION) $(CONTAINER) compose -f compose.yaml up -d --build
