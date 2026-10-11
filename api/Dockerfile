FROM rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3
RUN rustup component add rustfmt clippy
ENV CARGO_HOME=/cargo CARGO_TARGET_DIR=/target
WORKDIR /workspace
