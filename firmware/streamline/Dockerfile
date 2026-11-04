# Espressif's esp32 Rust 1.95 toolchain image. Update the tag and digest
# together after validating the complete Rust firmware build on hardware.
FROM docker.io/espressif/idf-rust:esp32_1.95.0.0@sha256:1f90203f191cc94d7da1acf4da0e0e87aac128165115c1512f30668359f09dc6

USER root
# ESP-IDF v6.1. esp-idf-svc zeroes the `wifi_init_config_t` fields it does not
# set, and `src/adapters/wifi.rs` fails the build when a bump changes that
# struct. QEMU never starts Wi-Fi, so only a device boot proves a bump.
ARG ESP_IDF_REV=fff9895c82d744c7237be8847347bdd1b07c6643
RUN git init /opt/streamline-idf \
    && git -C /opt/streamline-idf remote add origin https://github.com/espressif/esp-idf.git \
    && git -C /opt/streamline-idf fetch --depth 1 origin "$ESP_IDF_REV" \
    && git -C /opt/streamline-idf checkout --detach FETCH_HEAD \
    && git -C /opt/streamline-idf submodule update --init --recursive --depth 1 \
    && find /opt/streamline-idf -name .git -prune -exec rm -rf '{}' +
ENV IDF_PATH=/opt/streamline-idf

USER esp
WORKDIR /workspace
