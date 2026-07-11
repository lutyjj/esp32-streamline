FROM ghcr.io/astral-sh/uv:0.9.13-python3.14-bookworm-slim@sha256:84811734dd7ef34300d1a79a32ef0ed551b361ca318241e9a38b1305dea9b425 AS uv

FROM uv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_NO_DEV=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY pyproject.toml uv.lock /workspace/
RUN uv sync --locked --no-editable --no-install-project
COPY src /workspace/src
RUN uv sync --locked --no-editable
