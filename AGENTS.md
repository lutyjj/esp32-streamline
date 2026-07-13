# AGENTS.md

Rules for AI coding agents in this repository. Humans follow them too — see
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the PR flow.

## Understand before changing

Read [README.md](README.md) and `docs/` first. Do not re-derive decisions
already documented there.

## Value engineering time

Say what you want to say with the fewest words. Good engineers don't talk
much; they do.

## Write docs people can read

Lead with the point. Use active voice and simple sentences. State every fact
once, in the document that owns it, and link to it from everywhere else.
Assume readers range from firmware engineers to someone flashing their first
board.

## Write for the present, not the past

Document and comment the current state only. Never frame things as history —
no "previously X, now Y", "was/now", "changed from", or changelog narration in
docs or code comments. Write as if the code was always this way. History
lives in git.

## Keep logic testable; push hardware to the edges

Application logic lives in host-testable crate-root modules. ESP-IDF, the
network, and flash live behind `adapters/`; `main.rs` remains the composition
root and `runtime.rs` wires device tasks. New logic goes in the core;
adapters stay thin wiring. When the core must reach hardware, define a small
trait it owns and implement that trait in the adapter — never call a concrete
driver from the core. `update::install_verified` and its adapter in
`adapters/ota.rs` are the pattern to copy.

The console follows the same rule: behavior lives in `console/src/lib` and
`console/src/state` and is tested with vitest on the host; components stay
thin renderers over that state. A console behavior change ships with its
test.

## Write meaningful unit tests

Unit tests are design pressure, not coverage accounting. Test behavior at the
smallest useful unit, with hardware, sockets, clocks, and files replaced by
fakes or narrow interfaces. A useful unit test proves a contract, edge case, or
failure mode that can break independently; it does not just execute lines,
mirror implementation details, or exist to raise a coverage number. If logic
cannot be unit tested without a real device or service, move that logic inward
until it has a testable boundary.

## One module, one job

Each module does its own thing. Transport, parsing, orchestration, and
persistence do not share a file. A reader should learn what a module does
from its name and the first line of its doc comment.

## Simple, with seams

Write the simplest thing that works; do not add abstraction on speculation.
But isolate what changes — URLs, transports, sinks, clocks — behind a narrow
interface so it can be swapped or faked in a test. Abstract when it removes
duplication or unlocks a test, not before.

## Design for the whole journey

The console is one user journey, from first boot to steady streaming.
[docs/user-journey.md](docs/user-journey.md) defines its stages and promises;
judge any UI change against them: no dead ends, no unexplained interruptions,
no state the user cannot leave or understand. A change that fixes one screen
but opens a seam elsewhere in the journey is not done.

## Every capability is an API first

Machines are users too: scripts, tests, AI agents, and future clients (CLI,
MCP) must be able to drive the device end to end without a browser. Anything
a person can do in the console exists first as a clean HTTP endpoint that the
console merely calls. If a change adds behavior only a human clicking a UI
can reach, put the API in first and the UI on top.

## Derive cross-boundary contracts

When components share a wire format or API shape, define it once and derive
every representation that tooling supports. The Rust `api` module generates
`docs/openapi.json`; the firmware adapter uses its routes and DTOs, and the
console generates its client types from the artifact. Run
`make firmware-openapi` after a contract change. `docs/pcm-protocol.md` owns the
PCM frame that `src/protocol.rs` and the bridge's `protocol.py` implement
byte-exactly; its two implementations remain a deliberate exception until that
protocol has generation tooling.

## Components share one build contract

Each component (`bridge/`, `console/`, `firmware/`, `tools/`, `webflasher/`,
`ha-addon/`, `ha-integration/`) owns its Makefile, container image or build target, dependency
pins, and tool config. Component Makefiles expose the same verbs where they
apply — `format`, `lint`, `test`, `image` — and include `mk/common.mk` for
cross-cutting values. The root `Makefile` is the public interface:
`make <component>-<verb>` forwards to the component, and
`make lint | test | check | format` fan out across all of them. Prefer these
targets over ad-hoc docker invocations. To add a component: give it a
Makefile with the standard verbs, a `<name>-check` aggregate in the root
Makefile, and a filter entry in `.github/workflows/ci.yml`.

## Self-contained beats shared

Every component builds standalone: its Dockerfile starts `FROM` a public
image and its pins live in its own files. Accept small pin duplication —
Dependabot refreshes it according to the dependency boundary in
[`docs/architecture.md`](docs/architecture.md#components). Do not introduce
local base images or hidden include chains; a contributor must understand any
one component without tracing build plumbing. Deliberate exceptions own their
wiring locally: the firmware embeds `console/dist/index.html`; the bridge
packages `console/dist/bridge/bridge.html`; and the Home Assistant add-on
packages `bridge/`. Their owning Makefiles build these inputs before the
consuming image or binary.

## No unchecked code

Every language passes a strict, pinned, containerized check in `make lint`:
Rust through rustfmt and `clippy -D warnings`, Python through ruff and
`mypy --strict` (tests included), the web console through Biome. Host-side
Python lives in `tools/`, never as loose scripts. If you add a file type,
add its check to the owning component's lint target.

## A change is ready only when it is clean

A change is ready to commit only when the changed components build, pass tests,
and pass formatting and lint. Run the matching `make <component>-lint`,
`make <component>-test`, and build target when one applies. Run `make lint &&
make test` only for cross-component, CI, release, or integration changes, or
when explicitly requested. A console or webflasher-only change does not build
or test firmware.

## Prove firmware on a device

A firmware change is ready only after the new image ran on real hardware,
installed over the custom OTA path: the console's developer install under
System → Firmware, or `POST /api/ota/update` with `url` and `sha256`.
Serial flashing is for repartitioning, bootloader work, and recovery. Your
device's address and admin key live in the gitignored root `.env`
(see `.env.example`).

## Keep lab details out of public artifacts

Real device addresses, hostnames, network names, and keys belong only in the
gitignored `.env`. Never put them in code, tests, docs, commits, issues, or
pull requests — use documentation addresses (`192.0.2.x`) and neutral
hostnames in examples. Check the artifact before publishing, not after.

## Run in Docker, do not pollute the host

Run builds and checks in containers — the Makefiles already do. The only
host-side tools are `espflash` and the serial port, which containers cannot
reach on macOS.

## Use branches and pull requests

Do not push directly to `mainline`. Make changes on a feature branch and open
a pull request on GitHub.

## Use Conventional Commits

Use **Conventional Commits** (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).

## Do not commit generated or local-only files

Build outputs (`dist/`, `firmware/streamline/target/`, `.embuild/`), captures
(`captures/`, `analysis-data/`), site-bundled binaries (`webflasher/*.bin`),
and secrets (`.env`) stay out of git. See `.gitignore`; extend it if needed.

## Releases are tag-based

The version in `bridge/pyproject.toml`, `firmware/streamline/Cargo.toml`, and
`ha-addon/config.yaml` is the checked-in product version. `make release
VERSION=X.Y.Z` prepares all version files and the git-cliff-generated
`ha-addon/CHANGELOG.md`, then validates the release snapshot. Commit the result
in a `release/X.Y.Z` PR. After merge, release promotion revalidates the merge
commit, tags it, and dispatches publishing from that tag. See the
[README release steps](README.md#releases).

## Docs win on conflict

If anything here conflicts with `README.md` or `docs/`, the docs win and this
file is stale — update it.
