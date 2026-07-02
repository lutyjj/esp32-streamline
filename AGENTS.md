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

Application logic lives in the crate root (`config`, `levels`, `packet`,
`play`, `protocol`, `update`) and is tested on the host. ESP-IDF, the
network, and flash live behind `adapters/`. New logic goes in the core;
adapters stay thin wiring. When the core must reach hardware, define a small
trait it owns and implement that trait in the adapter — never call a concrete
driver from the core. `update::install_verified` and its adapter in
`adapters/ota.rs` are the pattern to copy.

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

## Mirror cross-boundary contracts

When two components share a wire format or API shape, write the shape down on
both sides and bind them with a comment naming the counterpart. The JSDoc
typedefs in `web/app.js` mirror the serde structs in `adapters/http.rs`;
`docs/pcm-protocol.md` defines the frame that both `src/protocol.rs` and the
bridge's `protocol.py` implement byte-exactly. Change one side, change the
other in the same PR.

## Components share one build contract

Each component (`bridge/`, `firmware/`, `tools/`, `webflasher/`) is
self-contained: it owns its Makefile, container image, dependency pins, and
tool config. Component Makefiles expose the same verbs where they apply —
`format`, `lint`, `test`, `image` — and include `mk/common.mk` for
cross-cutting values. The root `Makefile` is the public interface:
`make <component>-<verb>` forwards to the component, and
`make lint | test | check | format` fan out across all of them. Prefer these
targets over ad-hoc docker invocations. To add a component: give it a
Makefile with the standard verbs, a `<name>-check` aggregate in the root
Makefile, and a filter entry in `.github/workflows/ci.yml`.

## Self-contained beats shared

Every component builds standalone: its Dockerfile starts `FROM` a public
image and its pins live in its own files. Accept small pin duplication —
Dependabot refreshes it. Do not introduce local base images or hidden include
chains; a contributor must understand any one component without tracing build
plumbing.

## No unchecked code

Every language passes a strict, pinned, containerized check in `make lint`:
Rust through rustfmt and `clippy -D warnings`, Python through ruff and
`mypy --strict` (tests included), the web console through Biome. Host-side
Python lives in `tools/`, never as loose scripts. If you add a file type,
add its check to the owning component's lint target.

## A change is ready only when it is clean

A change is ready to commit only when it builds, passes tests, and passes
formatting and lint. Run `make lint && make test`; CI runs the same.

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

The version in `bridge/pyproject.toml` and `firmware/streamline/Cargo.toml`
is the checked-in product version. Create the matching `vX.Y.Z` tag only
after `make release VERSION=X.Y.Z` passes; the tag workflow publishes.
See the [README release steps](README.md#releases).

## Docs win on conflict

If anything here conflicts with `README.md` or `docs/`, the docs win and this
file is stale — update it.
