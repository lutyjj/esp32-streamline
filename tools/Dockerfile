FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY pyproject.toml /workspace/pyproject.toml
COPY src /workspace/src
RUN pip install --no-cache-dir '.[dev]'
