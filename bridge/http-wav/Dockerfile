FROM python:3.12-slim

ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="ESP32 StreamLine bridge"
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1

COPY protocol.py /app/protocol.py
COPY server.py /app/server.py

RUN useradd --uid 10001 --no-create-home streamline
USER streamline

EXPOSE 39000/tcp
EXPOSE 8088/tcp

CMD ["python3", "-u", "server.py"]
