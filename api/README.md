# StreamLine API

`streamline-api` owns the device HTTP contract and shared value models. Rust
consumers import the crate directly. Other languages generate clients or models
from [openapi.json](openapi.json).

The crate builds independently of firmware, ESP-IDF, the console and the bridge.
Its runtime dependency is Serde. The `openapi` feature enables the host-only
Utoipa exporter and its JSON dependency; firmware leaves that feature disabled.
Response types borrow strings where the producer already owns them.

## Ownership

| Module | Owns |
| --- | --- |
| `requests`, `responses` | Device wire bodies |
| `endpoints` | Methods, paths, authentication and response contracts |
| `board`, `audio`, `profiles`, `controls`, `settings` | Shared values, limits and value validation |
| `health` | Health report values |
| `examples` | Typed example payloads exported into the schema |

Firmware owns HTTP execution, authentication enforcement, boot assessment,
codec support, hardware operations and persistence. Its native HTTP adapter
registers the crate's endpoint declarations and consumes these exact types.
There is no generated Rust server or second set of Rust DTOs.

Schema annotations describe wire constraints; they do not execute validation.
Firmware validates incoming values before applying or persisting them. Values
whose validity depends on a selected board use the board's advertised limits.

The bridge retains its own FastAPI contract. Sharing this crate with a Rust
bridge does not require an OpenAPI-to-Rust generation step.

## Build and export

From the repository root:

```sh
make api-check
make api-openapi
```

`api-check` builds the library, runs tests and strict lint in the pinned Rust
container, and checks that the OpenAPI artifact matches the source.
`api-openapi` refreshes that artifact. Console checks generate TypeScript from
it, and the firmware embeds the same file at `/api/openapi.json`.

The Cargo package itself needs only this directory. Its Makefile uses the
repository's common container settings. Rust consumers can use `api/` as a path
dependency; only schema-export tooling needs the `openapi` feature.
