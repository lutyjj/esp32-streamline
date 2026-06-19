FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates clang-format git \
    && rm -rf /var/lib/apt/lists/*

COPY containers/requirements-tools.txt /tmp/requirements-tools.txt
RUN pip install --no-cache-dir -r /tmp/requirements-tools.txt

WORKDIR /workspace
