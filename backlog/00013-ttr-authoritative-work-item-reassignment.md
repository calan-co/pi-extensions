---
id: wi-00013
title: TTR Authoritative Work-Item Reassignment
summary: Provide an audited, POC-authorized correction path for erroneous authoritative work-item assignments.
type: work-item
subtype: task
lifecycle: in-progress
status: in-progress
status_reason: TTR defect ttr-23d18a51-4329-4851-90a6-ba59c1ea36b6
priority: high
estimated: 3
tags:
  - ttr
  - defect-tracking
  - audit
---

## Goal

Allow an explicitly authorized active owner POC to safely correct an erroneous authoritative work-item assignment without mutating external repositories or weakening assignment integrity.

## Background

TTR currently permits initial authoritative work-item assignment but permanently rejects any correction. A stale or colliding ID/path can therefore block a defect even after the correct unique work item is known.

## Tasks

- [ ] Model an immutable authoritative work-item assignment history with correction reason and evidence reference.
- [ ] Add an active-owner-only reassignment operation that validates the replacement ID, path, status, and configured lifecycle.
- [ ] Reject replacement collisions with another defect and unauthorized correction attempts.
- [ ] Preserve existing status history and prior work-item records.
- [ ] Expose clear TTR tool and slash-command semantics.
- [ ] Add regression coverage for the original collision, authorization failure, replacement validation, and audit history.

## Deliverables

- TTR core reassignment API and durable audit records.
- Guarded TTR tool/command surface.
- Updated TTR documentation and focused regression tests.

## Acceptance Criteria

- [ ] Only the active POC explicitly authorized for the defect domain can reassign its authoritative work item.
- [ ] Replacement ID/path/status/lifecycle values are validated before state mutation.
- [ ] A replacement work item already authoritative for another defect is rejected.
- [ ] Every correction preserves the previous assignment and immutable reason/evidence metadata.
- [ ] Existing work-item and status history remain intact after reassignment.
- [ ] Focused and broader validation pass without changes to Doc-Vader, CI, or protection settings.
