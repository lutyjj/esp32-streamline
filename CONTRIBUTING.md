# Contributing

Contributions are welcome, including AI-assisted ones.

## Development

Everything builds and checks in containers — install only Docker (or Podman)
and `make`:

```sh
make help    # component targets
make lint    # rustfmt, clippy, ruff, mypy --strict, biome
make test    # bridge + firmware tests, firmware release build
```

Flashing and serial need `espflash` on the host (`cargo install espflash`);
see [README.md](README.md).

## Pull requests

- Branch from `mainline`; do not push to it directly.
- Use [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).
- `make lint && make test` must pass; CI runs the same checks.
- Follow the component contract in [AGENTS.md](AGENTS.md) — it binds humans
  and AI agents alike.
