---
id: wi-00022
title: TTR Pi Durable Dedicated Pilot
summary: Run the `ttr-pilot` domain in shadow mode with a hashed manifest, deterministic selection, repository scope checks, and a no-op outbox.
type: work-item
subtype: feature
lifecycle: active
status: ready
status_reason: auto
priority: high
estimated: 5
links:
  depends_on:
    - '[[00021-ttr-pi-durable-foundation-spike]]'
tags:
  - afk
  - ttr
  - pi-durable
  - pilot
  - shadow-mode
  - tdd
---

## Goal

Prove one dedicated `ttr-pilot` domain can make reproducible shadow-only triage decisions without changing TTR state, invoking external effects, or routing live work.

## Test Seams

- **Core pilot API:** validate and hash the `ttr-pilot` manifest; reject an invalid domain, a repository outside its boundary, or a manifest hash mismatch; select one route deterministically from fixture input.
- **Service boundary:** open the durable service, submit a fixture report for shadow triage, expose its read-only decision/outbox state, and prove no live intake, TTR mutation, or external effect occurs.

## Tasks

- [ ] Add a dedicated `ttr-pilot` manifest with an explicit repository boundary, version, routing criteria, and approved no-op outbox adapter.
- [ ] Write the focused failing Core-pilot and service-boundary tests before implementation.
- [ ] Implement canonical manifest hashing and deterministic shadow route selection.
- [ ] Reject cross-boundary reports, stale/mismatched manifest hashes, and all non-shadow execution modes.
- [ ] Persist shadow decisions and no-op outbox entries as durable records without mutating the legacy TTR state.
- [ ] Run focused tests, relevant broader tests, type checks, independent review, and record Doc-Vader validation evidence.

## Deliverables

- Versioned `ttr-pilot` domain manifest.
- Durable shadow-routing API and read-only inspection boundary.
- No-op outbox record contract.
- Validation evidence and rollback note.

## Acceptance Criteria

- [ ] A fixture report has the same route and manifest hash across service reopen/replay.
- [ ] Reports outside the pilot repository boundary are rejected before a shadow decision is persisted.
- [ ] Reports with stale or mismatched manifest hashes are rejected before a shadow decision is persisted.
- [ ] Non-shadow execution modes are rejected without live routing or external effects.
- [ ] The outbox contains only a no-op shadow receipt and no external effect is invoked.
- [ ] The legacy TTR `state.json` is byte-for-byte unchanged.
- [ ] Existing foundation and extension tests pass unchanged.

## Rollback

Delete the pilot SQLite database and manifest. Do not migrate any shadow decision or outbox receipt into live TTR state.
