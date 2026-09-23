---
id: wi-00017
title: TTR Context Milestone Handoff
summary: Start fresh defect sessions at audited milestones with a rebuilt authoritative baseline and a clearly non-authoritative working handoff.
type: work-item
subtype: task
lifecycle: proposed
status: proposed
status_reason: TTR context-management recommendations for ttr-b01fd3c8-e62f-45c0-8fbb-5ad6200cf52d
priority: high
estimated: 3
links:
  depends_on:
    - '[[00016-ttr-context-guard]]'
tags:
  - ttr
  - context-management
  - handoff
  - operations
---

## Goal

Make long-running TTR work restartable without treating compaction, summaries, or handoffs as authority.

## Tasks

- [ ] Add a minimal milestone command that starts a fresh Pi session from the current validated defect/lane binding.
- [ ] Attach a working handoff marked non-authoritative and require live snapshot regeneration in the new session.
- [ ] Document one persisted Pi session per defect and coordinator domain, separate contributor/diagnosis sessions, and Pi branch limitations.
- [ ] Document context-mode as evidence retrieval only, including exact-source and live-state verification before action.
- [ ] Surface guard/baseline status in TTR session-facing UX without copying authority into session metadata.

## Deliverables

- Milestone session-refresh command.
- Operator procedure for naming, handoff, resume, and context-mode verification.
- Focused resume and handoff tests.

## Acceptance Criteria

- [ ] A milestone session begins with a fresh validated snapshot.
- [ ] The working handoff is visibly non-authoritative.
- [ ] A resumed session cannot act until its current binding and snapshot validate.
- [ ] The procedure does not rely on context search scope as a domain boundary.
