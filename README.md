# Pi Extensions

Public monorepo for Calan & Co Pi extensions.

## Extensions

- [`pi-autoname`](extensions/pi-autoname/README.md) — Transcript-based automatic Pi session names with `/autoname refresh` and `/name refresh` interception where supported.
- [`agent-workflows`](extensions/agent-workflows/README.md) — Pi-native delegation controls backed by Sandcastle sandboxes.
- [`pi-rewind`](extensions/pi-rewind/README.md) — Shadow-Git-backed workspace checkpoints for Pi `/tree` and `/fork` rewind.
- [`pi-channel`](extensions/pi-channel/README.md) — Pi-native durable membership through `/channel join`, `/channel leave`, `/channel list`, and `/channel diagnostics`, published to the authenticated local relay socket.
- [`triage-control-plane`](extensions/triage-control-plane/README.md) — Durable defect ownership, authoritative work-item lifecycle, evidence, and release-gate controls. Use `ttr_reassign_work_item` only as the active authorized owner POC; it requires a replacement work item, reassignment reason, and evidence references while retaining the prior item in audit history.
- [`pi-zellij-ux`](extensions/pi-zellij-ux/README.md) — Zellij-native UX and activity layer: consumes Pi topic activity and updates zellij session/tab/pane state.

## Out-of-repo extension packages

- `oppi-zellij` is maintained separately at `~/dev/oppi-zellij`.

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
