# custom_components

HACS installs a Home Assistant integration only from
`custom_components/<domain>/` at the repository root, so this directory is the
install surface for the `streamline` integration — a platform-fixed location,
like `repository.yaml` and `hacs.json` beside it. The `ha-integration/`
component owns the integration's toolchain, tests, and checks;
[docs/home-assistant.md](../docs/home-assistant.md) owns the install and
entity contracts.
