# Pi Extensions

Public monorepo for Calan & Co Pi extensions.

## Extensions

- [`pi-autoname`](extensions/pi-autoname/README.md) — Transcript-based automatic Pi session names with `/autoname refresh` and `/name refresh` interception where supported.
- [`agent-workflows`](extensions/agent-workflows/README.md) — Pi-native delegation controls backed by Sandcastle sandboxes.
- [`pi-rewind`](extensions/pi-rewind/README.md) — Shadow-Git-backed workspace checkpoints for Pi `/tree` and `/fork` rewind.
- [`pi-channel`](extensions/pi-channel/README.md) — Pi-native durable membership through `/channel join`, `/channel leave`, `/channel list`, and `/channel diagnostics`, published to the authenticated local relay socket.

## Development

```sh
pnpm install
pnpm test
```

## Loading an extension in Pi

Point Pi at the extension entrypoint you want to load, for example:

```json
{
  "extensions": [
    "/path/to/pi-extensions/extensions/agent-workflows/index.ts"
  ]
}
```

This repository intentionally excludes local runtime state, worktrees, node modules, API keys, and machine-specific configuration.
