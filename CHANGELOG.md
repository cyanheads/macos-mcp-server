# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-10-08

Adopts mcp-ts-core 0.13.14: tool error results carry a request ID, a number or boolean sent as a string and a null optional argument are repaired before validation, client log notifications honor MCP_LOG_LEVEL, and the registry HTTP entry starts the HTTP transport. Tool schemas are unchanged.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-09-24 · ⚠️ Breaking

Per-action required arguments and numeric bounds are enforced in the tool input schemas and fail as -32602 invalid_arguments; permission denials and missing apps or paths surface as typed reasons, and subprocess errors no longer carry the command line or script source.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-09-20 · ⚠️ Breaking

mcp-ts-core ^0.12.3 → ^0.13.6 — InvalidParams argument rejections with recovery hints, RequestCancelled disconnects, explicit stateless session mode, plus a manifest env-var wiring fix and forwarded recovery hints across six tools.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-08-22

mcp-ts-core ^0.12.3 (strict inputs, 2020-12 schemas, resource subscriptions), battery/display parsing fixes, community-health docs

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption, semantic error codes for tool failures, release/bundle tooling, plugin manifests

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-26

scripts migrated to bun run, funding config added, npm badge added, tsx removed

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

macOS 26.1 compatibility fixes: JSON audio parsing, AXMinimizeButton, CGWindowList unwrap; strip CLI commands from error messages

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

First functional release — 13 tools, 5 services, 3 resources for macOS system control

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — 13 tools, 3 resources for macOS system control via MCP
