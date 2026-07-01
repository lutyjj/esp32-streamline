include ../../mk/container.mk

IMAGE := esp32-streamline-analysis
PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache
ROOT_DIR := $(abspath ../..)
REF ?=
CAP ?=

# Run a command in the analysis image with the repo mounted. Targets append
# their own mounts/env before the image name.
CONTAINER_RUN := $(CONTAINER) run --rm -v "$(ROOT_DIR):/repo" -w /repo/tools/analysis

.PHONY: image lint capture

image:
	$(CONTAINER) build -f Dockerfile -t $(IMAGE) .

lint: image
	$(CONTAINER_RUN) -v "$(PYTHON_CACHE_VOLUME):/cache" -e MYPY_CACHE_DIR=/cache/mypy-analysis $(IMAGE) mypy --strict analyze_capture.py

capture: image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	$(CONTAINER_RUN) -v "$(HOME):$(HOME):ro" -v /tmp:/tmp $(IMAGE) python3 analyze_capture.py --reference "$(REF)" --capture "$(CAP)"
