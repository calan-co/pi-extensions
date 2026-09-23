---
id: wi-00015
title: TTR Authoritative Context Snapshot
summary: Render a bounded, versioned, read-only context baseline from live TTR state and the SME instruction manifest.
type: work-item
subtype: task
lifecycle: proposed
status: proposed
status_reason: TTR context-management recommendations for ttr-b01fd3c8-e62f-45c0-8fbb-5ad6200cf52d
priority: critical
estimated: 3
tags:
  - ttr
  - context-management
  - authority
  - snapshot
---

## Goal

Make current TTR state—not a transcript, summary, search result, or branch—the compact authoritative baseline available to a defect session.

## Tasks

- [ ] Define a versioned canonical snapshot schema containing defect ID, coordinator and contributor domains, scoped work items, lifecycle/status, allowed lane, and evidence references.
- [ ] Define a reviewed SME-instruction manifest keyed by domain and lane, with a version and content hash.
- [ ] Add a read-only TTR snapshot capability that renders the current baseline and its hash without embedding evidence bodies.
- [ ] Ensure the snapshot derives its data from live state on every request and preserves existing authorization behavior.
- [ ] Add focused coverage for deterministic hashes, current-state refresh, missing manifests, and cross-domain denial.

## Deliverables

- Snapshot schema and canonical hash contract.
- Versioned SME-instruction manifest format.
- Read-only snapshot tool and documentation.

## Acceptance Criteria

- [ ] A snapshot identifies its schema and SME-manifest versions and hashes.
- [ ] A state change produces a different current snapshot without relying on transcript history.
- [ ] Snapshots include references only, never unbounded evidence/log content.
- [ ] A caller cannot obtain a snapshot outside its authorized TTR scope.
- [ ] Focused regression tests pass.
