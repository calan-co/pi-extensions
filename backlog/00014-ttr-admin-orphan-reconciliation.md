---
id: wi-00014
title: TTR Admin Orphan Reconciliation
summary: Add auditable admin recovery for orphaned POCs, authoritative work-item rebinding, and supersession.
type: work-item
subtype: task
lifecycle: in-progress
status: in-progress
status_reason: TTR defect ttr-3d023e08-58c5-4231-8a92-f7afe872f3c4
priority: high
estimated: 5
tags: [ttr, admin, audit]
---

## Goal

Allow explicitly authorized TTR administrators to reconcile blocked orphaned work-item ownership without deleting original defect or work-item history.

## Tasks

- [x] Add admin lookup for defects, POCs, assignments, and orphan state.
- [x] Mark a POC assignment orphaned/inactive with required reason/evidence.
- [x] Rebind an authoritative work item to an active session at an explicit repository path.
- [x] Support obsolete/superseded assignments while retaining immutable audit history.
- [x] Add CLI/tool semantics and regression coverage for authorization, collisions, history, and supersession.

## Acceptance Criteria

- [x] Admin actions require explicit active-admin authority and reason/evidence.
- [x] Original defect, work item, assignment, and status history are retained.
- [x] Rebind validates active target session, replacement ID/path, lifecycle, and collisions.
- [x] Supersession creates a traceable successor without deleting the original.
- [ ] Focused and broader tests pass (broader suite is blocked by an external Pi module-resolution failure).
