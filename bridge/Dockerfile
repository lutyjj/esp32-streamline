FROM ghcr.io/astral-sh/uv:0.9.13-python3.14-bookworm-slim@sha256:84811734dd7ef34300d1a79a32ef0ed551b361ca318241e9a38b1305dea9b425 AS uv

FROM uv

ARG VERSION=dev
LABEL org.opencontainers.image.title="ESP32 StreamLine bridge"
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_NO_DEV=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=0

COPY pyproject.toml uv.lock /app/
RUN uv sync --locked --no-editable --no-install-project
COPY src /app/src
RUN uv sync --locked --no-editable \
    && useradd --uid 10001 --no-create-home streamline

USER streamline

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-bridge"]
