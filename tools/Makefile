include ../mk/common.mk

IMAGE := esp32-streamline-tools
REF ?=
CAP ?=

# Run a check in the tools image with the source mounted and the shared
# ruff/mypy cache volume attached.
CONTAINER_RUN := $(CONTAINER) run --rm \
	-v "$(CURDIR):/workspace" -v "$(PYTHON_CACHE_VOLUME):/cache" \
	-e RUFF_CACHE_DIR=/cache/ruff-tools -e MYPY_CACHE_DIR=/cache/mypy-tools \
	-w /workspace $(IMAGE)

# Mount only the directories holding the two input files, read-only, at their
# host paths so the arguments pass through unchanged. `sort` deduplicates when
# both files share a directory.
INPUT_DIRS = $(sort $(dir $(abspath $(REF))) $(dir $(abspath $(CAP))))
INPUT_MOUNTS = $(foreach d,$(INPUT_DIRS),-v "$(d):$(d):ro")

.PHONY: image format lint test analyze release-prepare

image:
	$(CONTAINER) build -f Dockerfile -t $(IMAGE) .

format: image
	$(CONTAINER_RUN) sh -c 'ruff check --select I --fix src tests && ruff format src tests'

lint: image
	$(CONTAINER_RUN) sh -c 'ruff format --check src tests && ruff check src tests && mypy'

test: image
	$(CONTAINER_RUN) sh -c 'PYTHONPATH=/workspace/src python3 -m unittest discover -s tests -v'

analyze: image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	$(CONTAINER) run --rm $(INPUT_MOUNTS) $(IMAGE) \
		streamline-analyze --reference "$(abspath $(REF))" --capture "$(abspath $(CAP))"

release-prepare: image
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	$(CONTAINER) run --rm -v "$(REPO_ROOT)":/repo -w /repo \
		-u $(shell id -u):$(shell id -g) -e HOME=/tmp $(IMAGE) \
		python3 -m streamline_tools.release --root /repo --version "$(VERSION)"
