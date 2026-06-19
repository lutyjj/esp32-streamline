FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir mypy==1.16.1 numpy==2.2.6

WORKDIR /workspace
