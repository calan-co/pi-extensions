---
id: wi-00019
title: TTR Zellij Restore Recovery
summary: Recover active registered TTR Pi sessions after a Zellij reboot when the ttr tab and stale panes remain.
type: work-item
subtype: task
lifecycle: in-progress
status: in-progress
status_reason: TTR defect ttr-b01fd3c8-e62f-45c0-8fbb-5ad6200cf52d
priority: high
estimated: 3
tags:
  - ttr
  - zellij
  - session-recovery
  - defect-tracking
---

## Goal

Make `/ttr restore` reconcile a surviving `ttr` Zellij tab with the active registered persisted Pi sessions it must host.

## Tasks

- [ ] Inspect existing TTR-tab panes using Zellij JSON metadata.
- [ ] Keep verified active `pi --session` panes, replace exited matching panes when safe, and create panes for missing sessions.
- [ ] Verify every active registered TTR session has a live matching Pi pane after restoration.
- [ ] Report incomplete recovery clearly without mutating TTR state.
- [ ] Add regression coverage for rebooted tabs, exited panes, missing panes, and failed verification.

## Deliverables

- Reboot-aware `/ttr restore` reconciliation.
- Focused command tests and operator documentation.

## Acceptance Criteria

- [ ] An existing `ttr` tab no longer short-circuits recovery.
- [ ] An exited pane with an unambiguous matching working directory is resumed or safely replaced with its registered Pi session.
- [ ] Missing registered sessions receive stacked replacement panes.
- [ ] Restore reports failure when any registered session cannot be verified active.
- [ ] TTR state and authorization behavior remain unchanged.
