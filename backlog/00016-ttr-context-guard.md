---
id: wi-00016
title: TTR Context Guard
summary: Rebuild and enforce an authoritative TTR baseline at session start and before each agent turn.
type: work-item
subtype: task
lifecycle: proposed
status: proposed
status_reason: TTR context-management recommendations for ttr-b01fd3c8-e62f-45c0-8fbb-5ad6200cf52d
priority: critical
estimated: 5
links:
  depends_on:
    - '[[00015-ttr-authoritative-context-snapshot]]'
tags:
  - ttr
  - context-management
  - authorization
  - guard
---

## Goal

Prevent a coordinator session from acting on a stale, missing, or cross-domain context baseline while keeping live TTR state authoritative.

## Tasks

- [ ] Add a non-authoritative per-session defect/lane binding that is revalidated against live TTR state.
- [ ] On session start and before each agent turn, inject the bounded current snapshot and matching SME instructions.
- [ ] Label transcript handoffs, branches, summaries, and retrieval output as non-authoritative.
- [ ] Block TTR mutations when the binding, actor scope, snapshot, or SME manifest is missing, stale, or mismatched.
- [ ] Preserve existing TTR core authorization and make no authority transfer through Pi branches or session metadata.
- [ ] Add tests for next-turn refresh, stale binding rejection, scope denial, compact/resume rebuild, and release-gate isolation.

## Deliverables

- Session binding and guard extension behavior.
- TTR mutation preflight for guarded sessions.
- Focused guard and lifecycle regression tests.

## Acceptance Criteria

- [ ] Every guarded turn receives a current live-state baseline.
- [ ] A stale or cross-domain binding cannot authorize a mutation.
- [ ] Compaction and resume rebuild the baseline rather than trusting a prior transcript.
- [ ] Branch summaries and handoffs cannot satisfy evidence or release requirements.
- [ ] Existing unguarded TTR authorization behavior remains unchanged.
