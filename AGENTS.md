# AGENTS.md

Rules for AI coding agents in this repository.

## Value engineering time

Say what you want to say with the fewest words. Good engineers don't
talk much; they do.

## Write for the present, not the past

Document and comment the current state only. Never frame things as history —
no "previously X, now Y", "was/now", "changed from", "bumped to", or changelog
narration in docs or code comments. Write as if the code was always this way.
History lives in git.

## Understand before changing

Read `README.md` and `docs/` to understand the project. Do not re-derive
decisions already documented there.

## Keep logic testable; push hardware to the edges

Application logic lives in the crate root (`config`, `packet`, `protocol`,
`update`) and is tested on the host. ESP-IDF, the network, and flash live behind
`adapters/`. New logic goes in the core; adapters stay thin wiring. When the core
must reach hardware, define a small trait it owns and implement that trait in the
adapter — never call a concrete driver from the core.

## One module, one job

Each module does its own thing. Transport, parsing, orchestration, and
persistence do not share a file. A reader should learn what a module does from
its name and the first line of its doc comment.

## Simple, with seams

Write the simplest thing that works; do not add abstraction on speculation. But
isolate what changes — URLs, transports, sinks, clocks — behind a narrow
interface so it can be swapped or faked in a test. Abstract when it removes
duplication or unlocks a test, not before.

## Build flows live in Makefiles

To understand the layout, run `tree` (or `git ls-files`). The root `Makefile`
is the public cross-project interface; each component Makefile owns its local
build, lint, test, and image flows. Prefer these targets over ad-hoc
docker/pio invocations.

## A change is ready only when it is clean

A change is ready to commit only when it builds, passes tests, and passes
formatting/lint. Run `make lint && make test`; CI runs the same.

## Run in Docker, do not pollute the host

Do not pollute the host environment. Run things in Docker whenever possible —
the `Makefile` already does this for build, lint, and test.

## Use branches and pull requests

Do not push directly to `mainline`. Make changes on a feature branch and open
a pull request on GitHub.

## Use Conventional Commits

Use **Conventional Commits** (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, …).

## Do not commit generated or local-only files

Do not commit generated or local-only files (`generated_web_ui.h`,
`local_config.h`, `.pio/`, `.platformio-home/`, `__pycache__/`). See
`.gitignore`. Extend it if needed.

## Releases are tag-based

The bridge package version in `bridge/pyproject.toml` is the checked-in product
version. Create the matching `vX.Y.Z` tag only after `make release
VERSION=X.Y.Z` passes. This target validates and builds local deliverables but
does not publish. GitHub publishes the firmware artifacts and bridge image from
that tag.

## Docs win on conflict

If anything here conflicts with `README.md` or `docs/`, the docs win and this
file is stale — update it.
