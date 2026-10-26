---
id: wi-00021
title: TTR Pi Durable Foundation Spike
summary: Prove a SQLite-backed Pi Durable TTR service foundation without enabling live routing or writes.
type: work-item
subtype: feature
lifecycle: active
status: ready
status_reason: Approved first stage of the Pi Durable migration; scope is limited to a reversible, no-live-routing foundation spike.
priority: critical
estimated: 5
links:
  depends_on:
    - '[[00020-ttr-pi-durable-service-migration]]'
tags:
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

- [ ] Add the minimal Pi Durable and SQLite dependencies and a service module isolated from the existing Pi extension.
- [ ] Define typed documents for domain registry, defect records, work-item/evidence references, migration metadata, and immutable audit entries.
- [ ] Write the focused failing Core-document and service-boundary tests before implementation.
- [ ] Implement an idempotent compatibility importer from a supplied TTR snapshot; persist source version/hash and audit receipt in the same commit.
- [ ] Implement read-only status inspection and a crash/reopen test for a replay-safe task.
- [ ] Explicitly reject live intake, routing, external effects, and non-replay-safe tasks in the foundation.
- [ ] Run focused tests, the relevant broader suite, type checks, independent review, and record Doc-Vader evidence.

## Deliverables

- Isolated Pi Durable TTR foundation module and tests.
- SQLite schema/document contract and compatibility-import receipt.
- Read-only status interface.
- Evidence and rollback note proving existing extension behavior remains unaffected.

## Acceptance Criteria

- [ ] A process restart resumes only the declared replay-safe test task.
- [ ] Import is idempotent and produces one immutable audit receipt per source snapshot.
- [ ] Read-only inspection cannot mutate the SQLite store or start/resume tasks.
- [ ] Live routing, deployment, requester messaging, tracker writes, and repository edits are unavailable from the foundation.
- [ ] Existing TTR extension tests pass unchanged.
- [ ] No migration touches the current TTR `state.json`.

## Rollback

Delete the spike SQLite database and service module. The current Pi extension and its state remain authoritative throughout this stage.
