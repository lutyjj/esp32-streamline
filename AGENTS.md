# AGENTS.md

Rules for AI coding agents in this repository.

## Value engineering time

Say what you want to say with the fewest words. Good engineers don't
talk much; they do.

## Understand before changing

Read `README.md` and `docs/` to understand the project. Do not re-derive
decisions already documented there.

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
