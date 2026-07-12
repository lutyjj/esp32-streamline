include ../mk/common.mk

# Static site served by GitHub Pages; the only machine-read file is the
# esp-web-tools manifest, which the pages workflow patches with jq at deploy
# time. Lint catches a malformed manifest before it ships.
IMAGE := esp32-streamline-webflasher-tools

.PHONY: image lint

image:
	$(CONTAINER) build -f Dockerfile -t $(IMAGE) .

lint: image
	$(CONTAINER) run --rm -v "$(CURDIR):/workspace" -w /workspace $(IMAGE) \
		python3 -m json.tool manifest.json /dev/null
