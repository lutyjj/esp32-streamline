IMAGE := esp32-streamline-analysis
PYTHON_CACHE_VOLUME ?= esp32-streamline-python-cache
ROOT_DIR := $(abspath ../..)
REF ?=
CAP ?=

.PHONY: image lint capture

image:
	docker build -f Dockerfile -t $(IMAGE) .

lint: image
	docker run --rm -v "$(ROOT_DIR):/repo" -v "$(PYTHON_CACHE_VOLUME):/cache" -e MYPY_CACHE_DIR=/cache/mypy-analysis -w /repo/tools/analysis $(IMAGE) mypy --strict analyze_capture.py

capture: image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	docker run --rm -v "$(ROOT_DIR):/repo" -v "$(HOME):$(HOME):ro" -v /tmp:/tmp -w /repo/tools/analysis $(IMAGE) python3 analyze_capture.py --reference "$(REF)" --capture "$(CAP)"
