# The current esp32_latest image resolved on 2026-06-20. Update the tag and
# digest together after validating the complete Rust firmware build on hardware.
FROM docker.io/espressif/idf-rust:esp32_latest@sha256:ce1c1dd44d457b94fc3fad2785f97cf3a78b7b9cfff778c41be54d94e6dd5757

USER root
# ESP-IDF 5.5 with Espressif's DRAM-safe OpenCores interrupt logging fix.
ARG ESP_IDF_REV=d42d785455789d3a3145fa19ab1068c2b8fc1e70
RUN git init /opt/streamline-idf \
    && git -C /opt/streamline-idf remote add origin https://github.com/espressif/esp-idf.git \
    && git -C /opt/streamline-idf fetch --depth 1 origin "$ESP_IDF_REV" \
    && git -C /opt/streamline-idf checkout --detach FETCH_HEAD \
    && git -C /opt/streamline-idf submodule update --init --recursive --depth 1 \
    && find /opt/streamline-idf -name .git -prune -exec rm -rf '{}' +
ENV IDF_PATH=/opt/streamline-idf

USER esp
WORKDIR /workspace
