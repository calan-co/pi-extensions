---
id: wi-00018
title: TTR Folding Satellite Pilot
summary: Evaluate one deterministic context-folding tool only in a copied, single-domain diagnosis session after the TTR context guard is established.
type: work-item
subtype: task
lifecycle: proposed
status: proposed
status_reason: TTR context-management recommendations for ttr-b01fd3c8-e62f-45c0-8fbb-5ad6200cf52d
priority: medium
estimated: 2
links:
  depends_on:
    - '[[00016-ttr-context-guard]]'
tags:
  - ttr
  - context-management
  - pilot
  - diagnosis
---

## Goal

Determine whether one reviewed deterministic folding tool helps output-heavy diagnosis without weakening TTR authority boundaries.

## Tasks

- [ ] Select exactly one pinned and reviewed candidate, such as `context-fold` or `pi-fold`.
- [ ] Run it only in a copied, single-domain satellite session; do not install it in a coordinator session.
- [ ] Verify resume, retrieval, native compaction interaction, baseline preservation, and cross-domain denial.
- [ ] Independently record any resulting conclusion through normal TTR evidence or audit operations.
- [ ] Document the outcome and retain native Pi compaction as the default unless the pilot proves safe and useful.

## Deliverables

- Reproducible pilot procedure and result record.
- Safety and usefulness assessment.

## Acceptance Criteria

- [ ] No coordinator session uses automatic pruning, aging, or an unreviewed context rewriter.
- [ ] The pilot cannot transfer authority through folded text, summaries, or branches.
- [ ] Live TTR baseline validation still precedes every mutation.
- [ ] The result explicitly recommends adoption or rejection with evidence.
