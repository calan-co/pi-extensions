---
id: wi-00020
title: TTR Pi Durable Service Migration Plan
summary: Establish the staged, Babysitter-DV-executed migration from Pi-session coordination to a hosted Pi Durable domain-control service.
type: work-item
subtype: task
lifecycle: proposed
status: proposed
status_reason: Pi Durable target architecture approved; implementation starts only through staged, evidence-gated Doc-Vader work items.
priority: critical
estimated: 3
tags:
  - ttr
  - pi-durable
  - babysitter-dv
  - migration
  - service
---

## Goal

Replace the session-oriented TTR target with a safe, staged path to a hosted, autonomous, domain-scoped TTR service without treating durable transcripts as authority.

## Tasks

- [ ] Treat `docs/architecture/ttr-pi-durable-service-migration.md` as the approved migration contract.
- [ ] Create the foundation-spike work item: SQLite-backed Pi Durable harness, typed TTR documents, read-only status, compatibility importer, and crash/resume tests.
- [ ] Create the single-domain pilot work item: hashed domain manifest, deterministic domain selection, repository boundary enforcement, no-op/outbox routing, and shadow comparison.
- [ ] Create the controlled-write-path work item: atomic TTR mutations, idempotent outbox receipts, replay classification, and extension fallback.
- [ ] Create the domain-workers/cutover work item only after the controlled write path has passed its rollback gate.
- [ ] Execute each ready item through `.a5c/processes/babysitter-dv.js#process`; retain the evidence journal, review, commit, and Doc-Vader closure records.

## Deliverables

- Versioned architecture and safety contract.
- A sequential Doc-Vader backlog for the four migration stages.
- Project-local Babysitter-DV process for evidence-gated execution.

## Acceptance Criteria

- [ ] The plan separates Pi Durable runtime durability from TTR authority and policy.
- [ ] The plan prohibits replaying non-idempotent external effects without a receipt.
- [ ] The foundation stage has Core-document and service-boundary test seams.
- [ ] A later stage cannot begin without prior-stage evidence and a rollback procedure.
- [ ] Existing Pi-extension state remains available until cutover is verified.
