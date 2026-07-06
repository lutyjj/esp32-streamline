FROM python:3.14-slim

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

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1

COPY bridge/pyproject.toml /app/bridge/pyproject.toml
COPY bridge/src /app/bridge/src
RUN pip install --no-cache-dir /app/bridge \
    && useradd --uid 10001 --no-create-home streamline

USER streamline

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-ha-addon"]
