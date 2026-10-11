include ../mk/common.mk

IMAGE := esp32-streamline-api-rust
RUN := $(CONTAINER) run --rm -v "$(CURDIR):/workspace" -w /workspace \
	-v esp32-streamline-api-cargo:/cargo -v esp32-streamline-api-target:/target $(IMAGE)

.PHONY: image format lint test build openapi openapi-check
image:
	$(CONTAINER) build -t $(IMAGE) .

format: image
	$(RUN) cargo fmt --all

lint: image
	$(RUN) cargo fmt --all -- --check
	$(RUN) cargo clippy --locked --all-targets -- -D warnings
	$(RUN) cargo clippy --locked --all-targets --features openapi -- -D warnings

test: image
	$(RUN) cargo test --locked --features openapi

build: image
	$(RUN) cargo build --locked

openapi: image
	$(RUN) cargo run --locked --quiet --features openapi --bin streamline-openapi -- /workspace/openapi.json

openapi-check: image
	$(RUN) sh -c 'cargo run --locked --quiet --features openapi --bin streamline-openapi -- /tmp/openapi.json && diff -u openapi.json /tmp/openapi.json'
