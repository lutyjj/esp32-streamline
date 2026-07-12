FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv

FROM python:3.14-slim-bookworm@sha256:4ff4b92a68355dbdb52584ab3391dff8d371a61d4e063468bfd0130e3189c6d9 AS lock-tool

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

ENV UV_NO_DEV=1

WORKDIR /workspace

COPY pyproject.toml uv.lock /workspace/
RUN uv sync --locked --no-editable --no-install-project
COPY src /workspace/src
RUN uv sync --locked --no-editable

FROM python:3.14-slim-bookworm@sha256:4ff4b92a68355dbdb52584ab3391dff8d371a61d4e063468bfd0130e3189c6d9 AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY --from=build /opt/venv /opt/venv

# Espressif's QEMU fork (the only QEMU with an ESP32 machine) for the smoke
# harness. Dependabot cannot follow a release-tarball pin: to bump, take the
# newest espressif/qemu release tag with the per-asset sha256 digests GitHub
# publishes for it, and update the tag and both digests together.
FROM python:3.14-slim-bookworm@sha256:4ff4b92a68355dbdb52584ab3391dff8d371a61d4e063468bfd0130e3189c6d9 AS qemu-runner

ENV PATH="/opt/qemu/bin:/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        libgcrypt20 libglib2.0-0 libpixman-1-0 libsdl2-2.0-0 libslirp0 \
    && rm -rf /var/lib/apt/lists/*

ARG QEMU_RELEASE=esp-develop-9.2.2-20260417
ARG QEMU_VERSION=esp_develop_9.2.2_20260417
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        arm64) QEMU_HOST=aarch64-linux-gnu; \
            QEMU_SHA256=00de5985094c14e47d1b38464a006b8ed64fd0fa7a289c56da24f3a329f65339 ;; \
        amd64) QEMU_HOST=x86_64-linux-gnu; \
            QEMU_SHA256=0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35 ;; \
        *) echo "no pinned QEMU build for architecture '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/qemu.tar.xz \
        "https://github.com/espressif/qemu/releases/download/$QEMU_RELEASE/qemu-xtensa-softmmu-$QEMU_VERSION-$QEMU_HOST.tar.xz" \
    && echo "$QEMU_SHA256  /tmp/qemu.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/qemu.tar.xz -C /opt \
    && rm /tmp/qemu.tar.xz

WORKDIR /workspace

COPY --from=build /opt/venv /opt/venv
