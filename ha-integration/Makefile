include ../mk/common.mk

DEV_IMAGE := esp32-streamline-ha-integration-dev
LOCK_IMAGE := esp32-streamline-ha-integration-lock
HASSFEST_IMAGE := esp32-streamline-ha-integration-hassfest
SOURCE := custom_components/streamline
TESTS := ha-integration/tests
CONFIG := ha-integration/pyproject.toml
OPENAPI := docs/bridge-openapi.json
GENERATED := custom_components/streamline/generated.py

CONTAINER_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR)/..:/repo" \
	-e RUFF_CACHE_DIR=/tmp/ruff-ha-integration -e MYPY_CACHE_DIR=/tmp/mypy-ha-integration \
	-e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 \
	-w /repo $(DEV_IMAGE)
LOCK_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR):/workspace" -e UV_CACHE_DIR=/tmp/uv-cache \
	-w /workspace $(LOCK_IMAGE) uv

.PHONY: lock-image dev-image hassfest-image format lint lock lock-upgrade lock-check generate generate-check test hassfest package check

lock-image:
	$(CONTAINER) build -f Dockerfile --target lock-tool -t $(LOCK_IMAGE) .

lock: lock-image
	$(LOCK_RUN) lock

lock-upgrade: lock-image
	$(LOCK_RUN) lock --upgrade

lock-check: lock-image
	$(LOCK_RUN) lock --check

generate: dev-image
	$(CONTAINER_RUN) datamodel-codegen --input $(OPENAPI) --input-file-type openapi \
		--openapi-scopes schemas --output-model-type pydantic_v2.BaseModel \
		--target-python-version 3.14 --use-standard-collections --use-union-operator \
		--enum-field-as-literal all --use-annotated --disable-timestamp --formatters builtin \
		--output $(GENERATED)
	$(CONTAINER_RUN) sh -c 'ruff format --config $(CONFIG) $(GENERATED) && \
		ruff check --config $(CONFIG) --fix $(GENERATED) && \
		ruff format --config $(CONFIG) $(GENERATED)'

generate-check: dev-image
	$(CONTAINER_RUN) sh -c 'datamodel-codegen --input $(OPENAPI) --input-file-type openapi \
		--openapi-scopes schemas --output-model-type pydantic_v2.BaseModel \
		--target-python-version 3.14 --use-standard-collections --use-union-operator \
		--enum-field-as-literal all --use-annotated --disable-timestamp --formatters builtin \
		--output /tmp/generated.py && \
		ruff format --config $(CONFIG) /tmp/generated.py && \
		ruff check --config $(CONFIG) --fix /tmp/generated.py && \
		ruff format --config $(CONFIG) /tmp/generated.py && \
		diff -u $(GENERATED) /tmp/generated.py'

dev-image:
	$(CONTAINER) build -f Dockerfile --target development -t $(DEV_IMAGE) .

hassfest-image:
	$(CONTAINER) build -f Dockerfile.hassfest -t $(HASSFEST_IMAGE) .

format: dev-image
	$(CONTAINER_RUN) sh -c 'ruff check --config $(CONFIG) --select I --fix $(SOURCE) $(TESTS) && ruff format --config $(CONFIG) $(SOURCE) $(TESTS)'

lint: dev-image
	$(CONTAINER_RUN) sh -c 'ruff format --config $(CONFIG) --check $(SOURCE) $(TESTS) && ruff check --config $(CONFIG) $(SOURCE) $(TESTS) && mypy --config-file $(CONFIG) $(SOURCE) $(TESTS)'
	cmp ../custom_components/streamline/strings.json ../custom_components/streamline/translations/en.json

test: dev-image
	$(CONTAINER_RUN) sh -c 'PYTHONPATH=/repo pytest -p no:cacheprovider -q $(TESTS)'

hassfest: hassfest-image
	$(CONTAINER) run --rm -v "$(CURDIR)/..:/repo:ro" $(HASSFEST_IMAGE) \
		--core-path=/tmp --integration-path=/repo/custom_components/streamline

package:
	@test -f ../hacs.json
	@test "$$(find ../custom_components -mindepth 2 -maxdepth 2 -name manifest.json | wc -l | tr -d ' ')" = "1"
	@test -f ../custom_components/streamline/manifest.json
	@test -f ../custom_components/streamline/generated.py
	@test -f ../custom_components/streamline/brand/icon.png
	@test -f ../custom_components/streamline/brand/logo.png

check: lock-check generate-check lint test hassfest package
