# Contributing

Contributions are welcome, including AI-assisted ones.

## Development

Builds and checks run in containers. Install Docker (or Podman) and `make`:

```sh
make help    # component targets
make lint    # rustfmt, clippy, ruff, mypy --strict, biome
make test    # component tests and firmware release build
```

Flashing (`make firmware-flash`), serial capture (`make firmware-capture`),
and the device smoke (`make tools-smoke-device`) run on the host. They need
`espflash` (`cargo install espflash`) and Python 3 with `requests`; see
[README.md](README.md). On Linux, your user also needs the serial device's
group, usually `dialout`.

With Nix, `nix develop` opens a shell with `make`, `espflash`, and that Python,
pinned by `flake.lock`. To load it on entering the checkout with direnv, run
`echo 'use flake' > .envrc && direnv allow` once; git ignores `.envrc` and
`.direnv/`. The shell leaves the build toolchains to the component images and
the container runtime to the system: on NixOS, enable
`virtualisation.docker.enable` or `virtualisation.podman.enable`. Format
`flake.nix` with `nix fmt`; `make repository-check` evaluates the shell for
every supported system and checks its format.

GitHub-hosted build jobs use Google's `mirror.gcr.io` cache for Docker Hub
images through the [runner setup action](.github/actions/docker-mirror/action.yml).
The action clears the runner's default Docker Hub login so the public cache
accepts anonymous pulls. Other registry credentials are unaffected.
Docker keeps the image references and digest checks and falls back to Docker Hub
on cache misses. The cache reduces shared-runner pull-limit failures; it does
not guarantee availability for every image. Local Docker configuration is unchanged.

Working against a real device? Copy [.env.example](.env.example) to `.env`
(gitignored) and set your device's address there. Makefiles read
it, so `make console-dev` proxies to your node without extra flags.

No device? `make console-dev-mock` serves the device console against an
in-memory fake and the bridge console against a real bridge container:
<http://localhost:5173/> is the device console (`?scenario=first-boot`
starts at onboarding), `/bridge.html` the bridge console. The fake device
unlocks with 48 `a`s as the admin key; the bridge with the token
`streamline-dev-bridge-token` (override with `BRIDGE_TOKEN=…`).
`make console-dev DEV_PORT=5174` opens a second preview against the device in
`.env`, leaving the mock preview available.
`make console-e2e` runs the Playwright journey specs against the same
backends.

## Pull requests

- Branch from `mainline`; do not push to it directly.
- Use [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).
- `make lint && make test` must pass; CI runs the matching component checks.
- Follow the component contract in [AGENTS.md](AGENTS.md). It binds humans
  and AI agents alike.
