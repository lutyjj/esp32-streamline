include ../mk/common.mk

# Static site served by GitHub Pages; the only machine-read file is the
# esp-web-tools manifest, which the pages workflow patches with jq at deploy
# time. Lint catches a malformed manifest before it ships.
.PHONY: lint

lint:
	$(CONTAINER) run --rm -v "$(CURDIR):/workspace" -w /workspace python:3.12-slim \
		python3 -m json.tool manifest.json /dev/null
