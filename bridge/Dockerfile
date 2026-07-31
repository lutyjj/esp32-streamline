FROM ghcr.io/astral-sh/uv:0.11.33@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 AS uv

FROM python:3.14-slim-bookworm@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS lock-tool

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=0

COPY --from=uv /uv /usr/local/bin/uv

FROM lock-tool AS development

WORKDIR /workspace

COPY pyproject.toml uv.lock /workspace/
RUN uv sync --locked --no-editable --no-install-project
COPY src /workspace/src
RUN uv sync --locked --no-editable

FROM lock-tool AS build

WORKDIR /app
ENV UV_NO_DEV=1

COPY pyproject.toml uv.lock /app/
RUN uv sync --locked --no-editable --no-install-project
COPY src /app/src
RUN uv sync --locked --no-editable

FROM python:3.14-slim-bookworm@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS runtime

ARG VERSION=dev
LABEL org.opencontainers.image.title="ESP32 StreamLine bridge"
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=build /opt/venv /opt/venv
RUN useradd --uid 10001 --no-create-home streamline \
    && mkdir /recordings /data \
    && chown streamline:streamline /recordings /data

USER streamline

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-bridge"]
