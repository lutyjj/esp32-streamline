# Contributing

Contributions are welcome, including AI-assisted ones; the project itself is
built with heavy AI use. [AGENTS.md](AGENTS.md) states the engineering rules,
and [architecture](docs/architecture.md#document-ownership) maps the docs.

## Development

Builds and checks run in containers. Install Docker (or Podman) and `make`:

```sh
make help                              # every target
make lint && make test                 # rustfmt, clippy, ruff, mypy --strict, biome; tests
make repository-check                  # docs, metadata, versions, advisories
make firmware-build                    # cross-compile the firmware
make bridge-up                         # run the bridge from source
```

### Flashing and serial

Flashing (`make firmware-flash`), the serial monitor (`make firmware-monitor`),
bounded capture (`make firmware-capture CAPTURE_SECS=30`), and the device smoke
(`make tools-smoke-device`) run on the host, because Docker Desktop on macOS
cannot reliably expose serial devices. They need `espflash`
(`cargo install espflash`) and Python 3 with `requests`. On Linux, your user
also needs the serial device's group, usually `dialout`.

Flash with `make firmware-flash`, not a bare `espflash flash`: the target also
writes the rollback bootloader and the two-slot partition table that OTA
updates depend on, with a flash-size header that matches the chip.

espflash selects the serial port. When exactly one USB serial adapter is
attached and espflash recognizes it (CP210x, CH340) or remembers it, every
serial target uses it. Otherwise set `ESPFLASH_PORT`, for example
`ESPFLASH_PORT=/dev/ttyUSB0 make firmware-capture`; for a single unrecognized
adapter, `make firmware-flash` offers to remember it. Without that setting,
`firmware-capture` and `tools-smoke-device` fail when several adapters are
attached. With one unrecognized adapter, `tools-smoke-device` fails, and
`firmware-capture` fails too unless it runs in a terminal, where it waits at
espflash's port prompt until its window ends.

A device on the network needs no serial port to be read: it serves its log at
`GET /api/logs` and its last crash dump at `GET /api/coredump/image`. See
[diagnostics](docs/diagnostics.md).

### Development shell

With Nix, `nix develop` opens a shell with `make`, `espflash`, and that Python,
pinned by `flake.lock`. To load it on entering the checkout with direnv, run
`echo 'use flake' > .envrc && direnv allow` once; git ignores `.envrc` and
`.direnv/`. The shell leaves the build toolchains to the component images and
the container runtime to the system: on NixOS, enable
`virtualisation.docker.enable` or `virtualisation.podman.enable`. Format
`flake.nix` with `nix fmt`; `make repository-check` evaluates the shell for
every supported system and checks its format.

### Consoles

Working against a real device? Copy [.env.example](.env.example) to `.env`
(gitignored) and set your device's address there. Makefiles read
it, so `make console-dev` proxies to your node without extra flags.

No device? `make console-dev-mock` serves the device console against an
in-memory fake and the bridge console against a real bridge container, which
`streamline-pcm-source` feeds with the firmware's conformance frames:
<http://localhost:5173/> is the device console (`?scenario=first-boot`
starts at onboarding), `/bridge.html` the bridge console. The fake device
unlocks with 48 `a`s as the admin key; the bridge with the token
`streamline-dev-bridge-token` (override with `BRIDGE_TOKEN=…`).
`make console-dev DEV_PORT=5174` opens a second preview against the device in
`.env`, leaving the mock preview available.
`make console-e2e` runs the Playwright journey specs against the same
backends.

### Home Assistant app

The Home Assistant app's AppArmor profile has two gates.
`make ha-addon-lint` compiles the profile, which cannot show that a kernel
enforces it. `make ha-addon-apparmor-test` runs the Home Assistant app's
container image under a disposable enforcing copy of the profile, so it needs
a Docker host with AppArmor enabled. `make test` leaves it out; `make ha-addon-check` runs it.

### CI image cache

GitHub-hosted build jobs use Google's `mirror.gcr.io` cache for Docker Hub
images through the [runner setup action](.github/actions/docker-mirror/action.yml),
except the release's Home Assistant app build, whose BuildKit builder cannot use a Docker
daemon mirror.
The action clears the runner's default Docker Hub login so the public cache
accepts anonymous pulls. Other registry credentials are unaffected.
Docker keeps the image references and digest checks and falls back to Docker Hub
on cache misses. The cache reduces shared-runner pull-limit failures; it does
not guarantee availability for every image. Local Docker configuration is unchanged.

## Pull requests

- Branch from `mainline`; do not push to it directly.
- Use [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).
- `make lint && make test` must pass; CI runs the matching component checks.
- Follow the component contract in [AGENTS.md](AGENTS.md). It binds humans
  and AI agents alike.

## Releases

To release, merge the release PR that
[release-please](https://github.com/googleapis/release-please) keeps open on
`mainline`. Publication then runs on its own, as
[build, CI, and release](docs/architecture.md#build-ci-and-release) describes,
and signs the firmware with the `FIRMWARE_SIGNING_KEY` secret
([firmware signing](docs/ota.md#firmware-signing)). If publication is
interrupted, rerun **Actions → Release** with the same tag; every step
converges. Never edit the version files or changelog by hand: land a
Conventional Commit and let the release PR carry it.
[Artifact verification](docs/security.md#release-artifact-verification) shows
how to check what a release published.
