FROM ghcr.io/astral-sh/uv:0.11.29@sha256:eb2843a1e56fd9e30c7276ce1a52cba86e64c7b385f5e3279a0e08e02dd058fc AS uv

FROM python:3.14-slim-bookworm@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS build

WORKDIR /app/bridge
ENV PYTHONDONTWRITEBYTECODE=1 \
    UV_NO_DEV=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=0

COPY --from=uv /uv /usr/local/bin/uv
COPY bridge/pyproject.toml bridge/uv.lock ./
RUN uv sync --locked --no-editable --no-install-project
COPY bridge/src ./src
RUN uv sync --locked --no-editable

FROM python:3.14-slim-bookworm@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS runtime

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
    PYTHONDONTWRITEBYTECODE=1

COPY --from=build /opt/venv /opt/venv

# Home Assistant owns /data/options.json; run under the Supervisor's default
# container user so the add-on can read its mounted configuration.

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-ha-addon"]
