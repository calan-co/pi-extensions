---
id: wi-00021
title: TTR Pi Durable Foundation Spike
summary: Prove a SQLite-backed Pi Durable TTR service foundation without enabling live routing or writes.
type: work-item
subtype: feature
lifecycle: active
status: completed
status_reason: completed
priority: critical
estimated: 5
actual: 5
completed_date: '2026-10-26'
commits:
  462f752f7ac038738b7976204d3bea73ca2622a6: Pi Durable foundation direct push
links:
  evidence:
    - '[[record-administrator-approval-receipt-for-ttr-pi-durable-foundation-direct-push-reconciliation]]'
    - '[[record-ttr-pi-durable-foundation-validation]]'
  reference:
    - '[[record-administrator-approval-for-ttr-pi-durable-foundation-direct-push-reconciliation]]'
tags:
  - afk
  - ttr
  - pi-durable
  - sqlite
  - tdd
  - migration
---

## Goal

Create the smallest runnable hosted-service foundation for TTR: a SQLite-backed `@earendil-works/pi-durable` harness, typed canonical TTR documents, a compatibility importer, and a read-only status boundary. It must not accept live routing, external effects, or authoritative writes.

## Test Seams

- **Core document API:** import and inspect canonical TTR state; atomically append its audit entry; reject malformed or duplicate import input.
- **Service boundary:** open the SQLite service, expose read-only status, resume a pending safe task after reopen, and reject attempts to use the foundation as a live routing/write service.

## Tasks

- [x] Add the minimal Pi Durable and SQLite dependencies and a service module isolated from the existing Pi extension.
- [x] Define typed documents for domain registry, defect records, work-item/evidence references, migration metadata, and immutable audit entries.
- [x] Write the focused failing Core-document and service-boundary tests before implementation.
- [x] Implement an idempotent compatibility importer from a supplied TTR snapshot; persist source version/hash and audit receipt in the same commit.
- [x] Implement read-only status inspection and a crash/reopen test for a replay-safe task.
- [x] Explicitly reject live intake, routing, external effects, and non-replay-safe tasks in the foundation.
- [x] Run focused tests, the relevant broader suite, type checks, independent review, and record Doc-Vader evidence.

## Deliverables

- Isolated Pi Durable TTR foundation module and tests.
- SQLite schema/document contract and compatibility-import receipt.
- Read-only status interface.
- Evidence and rollback note proving existing extension behavior remains unaffected.

## Acceptance Criteria

- [x] A process restart resumes only the declared replay-safe test task.
- [x] Re-importing the same canonical snapshot is idempotent; a different second snapshot is rejected without a second audit receipt.
- [x] Read-only inspection cannot mutate the SQLite store or start/resume tasks.
- [x] Live routing, deployment, requester messaging, tracker writes, and repository edits are unavailable from the foundation.
- [x] Existing TTR extension tests pass unchanged.
- [x] No migration touches the current TTR `state.json`.

## Rollback

Delete the spike SQLite database and service module. The current Pi extension and its state remain authoritative throughout this stage.
