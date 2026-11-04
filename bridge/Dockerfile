FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

FROM python:3.15-slim-trixie@sha256:8c13a3f37a6a5b71498228e902c4b9f51c1f7900d49fabf71f9a650c6120e0d0 AS lock-tool

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

FROM python:3.15-slim-trixie@sha256:8c13a3f37a6a5b71498228e902c4b9f51c1f7900d49fabf71f9a650c6120e0d0 AS runtime

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
