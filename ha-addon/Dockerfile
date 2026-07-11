FROM ghcr.io/astral-sh/uv:0.9.13-python3.14-bookworm-slim@sha256:84811734dd7ef34300d1a79a32ef0ed551b361ca318241e9a38b1305dea9b425

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64

LABEL org.opencontainers.image.title="Home Assistant Add-on: ESP32 StreamLine Bridge"
LABEL org.opencontainers.image.description="ESP32 StreamLine TCP PCM to HTTP WAV bridge for Home Assistant"
LABEL org.opencontainers.image.source="https://github.com/lutyjj/esp32-streamline"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.version="${BUILD_VERSION}"
LABEL io.hass.version="${BUILD_VERSION}"
LABEL io.hass.type="app"
LABEL io.hass.arch="${BUILD_ARCH}"

WORKDIR /app/bridge
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_NO_DEV=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=0

COPY bridge/pyproject.toml bridge/uv.lock ./
RUN uv sync --locked --no-editable --no-install-project
COPY bridge/src ./src
RUN uv sync --locked --no-editable

# Home Assistant owns /data/options.json; run under the Supervisor's default
# container user so the add-on can read its mounted configuration.

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-ha-addon"]
