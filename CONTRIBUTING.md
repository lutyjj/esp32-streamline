# Contributing

Contributions are welcome, including AI-assisted ones.

## Development

Everything builds and checks in containers — install only Docker (or Podman)
and `make`:

```sh
make help    # component targets
make lint    # rustfmt, clippy, ruff, mypy --strict, biome
make test    # component tests and firmware release build
```

Flashing and serial need `espflash` on the host (`cargo install espflash`);
see [README.md](README.md).

Working against a real device? Copy [.env.example](.env.example) to `.env`
(gitignored) and set your device's address there — Makefiles and agents read
it, so `make console-dev` proxies to your node without extra flags.

No device? `make console-dev-mock` serves both consoles against in-memory
fake backends: <http://localhost:5173/> is the device console
(`?scenario=first-boot` starts at onboarding), `/bridge.html` the bridge
console. The fake device unlocks with 48 `a`s as the admin key; the fake
bridge with the token `mock-bridge-token`.

## Pull requests

- Branch from `mainline`; do not push to it directly.
- Use [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).
- `make lint && make test` must pass; CI runs the matching component checks.
- Follow the component contract in [AGENTS.md](AGENTS.md) — it binds humans
  and AI agents alike.
