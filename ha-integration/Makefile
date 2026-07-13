include ../mk/common.mk

DEV_IMAGE := esp32-streamline-ha-integration-dev
LOCK_IMAGE := esp32-streamline-ha-integration-lock
HASSFEST_IMAGE := esp32-streamline-ha-integration-hassfest

# The integration source lives at the repository root because HACS requires
# custom_components/ there; this directory owns its toolchain and tests.
SOURCE := custom_components/streamline
TESTS := ha-integration/tests
CONFIG := ha-integration/pyproject.toml
OPENAPI := docs/bridge-openapi.json
MODELS := custom_components/streamline/models.py

CONTAINER_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR)/..:/repo" \
	-e RUFF_CACHE_DIR=/tmp/ruff -e MYPY_CACHE_DIR=/tmp/mypy \
	-e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 \
	-w /repo $(DEV_IMAGE)
LOCK_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR):/workspace" -e UV_CACHE_DIR=/tmp/uv-cache \
	-w /workspace $(LOCK_IMAGE) uv

# Render the bridge OpenAPI schemas into Pydantic models at $(1), formatted so
# the artifact passes this component's lint.
render_models = datamodel-codegen --input $(OPENAPI) --input-file-type openapi \
	--openapi-scopes schemas --output-model-type pydantic_v2.BaseModel \
	--target-python-version 3.14 --use-standard-collections --use-union-operator \
	--enum-field-as-literal all --use-annotated --disable-timestamp --formatters builtin \
	--output $(1) && \
	ruff format --config $(CONFIG) $(1) && \
	ruff check --config $(CONFIG) --fix $(1) && \
	ruff format --config $(CONFIG) $(1)

.PHONY: lock-image dev-image hassfest-image format lint lock lock-upgrade lock-check generate generate-check test hassfest check

lock-image:
	$(CONTAINER) build -f Dockerfile --target lock-tool -t $(LOCK_IMAGE) .

lock: lock-image
	$(LOCK_RUN) lock

lock-upgrade: lock-image
	$(LOCK_RUN) lock --upgrade

lock-check: lock-image
	$(LOCK_RUN) lock --check

dev-image:
	$(CONTAINER) build -f Dockerfile --target development -t $(DEV_IMAGE) .

generate: dev-image
	$(CONTAINER_RUN) sh -c '$(call render_models,$(MODELS))'

generate-check: dev-image
	$(CONTAINER_RUN) sh -c '$(call render_models,/tmp/models.py) && diff -u $(MODELS) /tmp/models.py'

format: dev-image
	$(CONTAINER_RUN) sh -c 'ruff check --config $(CONFIG) --select I --fix $(SOURCE) $(TESTS) && ruff format --config $(CONFIG) $(SOURCE) $(TESTS)'

lint: dev-image
	$(CONTAINER_RUN) sh -c 'ruff format --config $(CONFIG) --check $(SOURCE) $(TESTS) && ruff check --config $(CONFIG) $(SOURCE) $(TESTS) && mypy --config-file $(CONFIG) $(SOURCE) $(TESTS)'
	cmp ../$(SOURCE)/strings.json ../$(SOURCE)/translations/en.json

test: dev-image
	$(CONTAINER_RUN) sh -c 'PYTHONPATH=/repo pytest -p no:cacheprovider -q $(TESTS)'

hassfest: hassfest-image
	$(CONTAINER) run --rm -v "$(CURDIR)/..:/repo:ro" $(HASSFEST_IMAGE) \
		--core-path=/tmp --integration-path=/repo/custom_components/streamline

hassfest-image:
	$(CONTAINER) build -f Dockerfile.hassfest -t $(HASSFEST_IMAGE) .

check: lock-check generate-check lint test hassfest
