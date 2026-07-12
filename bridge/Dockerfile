FROM python:3.14-slim

ARG VERSION=dev
LABEL org.opencontainers.image.title="ESP32 StreamLine bridge"
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1

COPY pyproject.toml /app/pyproject.toml
COPY src /app/src
RUN pip install --no-cache-dir . \
    && useradd --uid 10001 --no-create-home streamline \
    && mkdir /recordings \
    && chown streamline:streamline /recordings

USER streamline

EXPOSE 39000/tcp
EXPOSE 8088/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=2)"]

ENTRYPOINT ["streamline-bridge"]
