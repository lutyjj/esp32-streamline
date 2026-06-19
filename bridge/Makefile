DEV_IMAGE := esp32-streamline-bridge-dev
IMAGE ?= esp32-streamline-bridge
VERSION ?= $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' pyproject.toml)
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088
PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache

.PHONY: dev-image format lint test image run up

dev-image:
	docker build -f Dockerfile.dev -t $(DEV_IMAGE) .

format: dev-image
	docker run --rm -v "$(CURDIR):/workspace" -v "$(PYTHON_CACHE_VOLUME):/cache" -e RUFF_CACHE_DIR=/cache/ruff -w /workspace $(DEV_IMAGE) sh -c 'ruff check --select I --fix src tests && ruff format src tests'

lint: dev-image
	docker run --rm -v "$(CURDIR):/workspace" -v "$(PYTHON_CACHE_VOLUME):/cache" -e RUFF_CACHE_DIR=/cache/ruff -e MYPY_CACHE_DIR=/cache/mypy -w /workspace $(DEV_IMAGE) sh -c 'ruff format --check src tests && ruff check src tests && mypy'

test: dev-image
	docker run --rm -v "$(CURDIR):/workspace" -e PYTHONPATH=/workspace/src -w /workspace $(DEV_IMAGE) python3 -m unittest discover -s tests -v

image:
	docker build -f Dockerfile --build-arg VERSION=$(VERSION) -t $(IMAGE):$(VERSION) .

run: image
	docker run --rm $(BRIDGE_PORTS) $(IMAGE):$(VERSION) $(BRIDGE_ARGS)

up:
	STREAMLINE_VERSION=$(VERSION) docker compose -f compose.yaml up -d --build
