ESPHOME_IMAGE ?= ghcr.io/esphome/esphome:2026.6.1
CONFIG ?= configs/audio-kit.yaml
CACHE_DIR ?= $(CURDIR)/.cache

.PHONY: validate build

validate:
	docker run --rm -v "$(CURDIR):/config" -v "$(CACHE_DIR):/cache" -w /config $(ESPHOME_IMAGE) --toolchain esp-idf config $(CONFIG)

build:
	docker run --rm -v "$(CURDIR):/config" -v "$(CACHE_DIR):/cache" -w /config $(ESPHOME_IMAGE) --toolchain esp-idf compile $(CONFIG)
