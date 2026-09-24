# Triage Control Plane (TTR)

TTR is a durable Pi control plane for defect provenance, coordinator routing, scoped tracker references, and release evidence. It records state; it does not transport messages, synchronize external trackers, deploy, or edit repository backlog files.

## Ownership model

Each defect contains:

- immutable `report` provenance: reporter, source, optional `sourceDomain`, symptom, impact, environment, reproduction, evidence references, and recorded time;
- one mutable `coordinatorDomain`, whose active Manager is always resolved from the registry at the time of an operation (no copied owner session is stored);
- zero or more normalized `contributingDomains`;
- domain-keyed `workItems`: one lead canonical reference and later contributor references; an active admin may explicitly move the lead reference to a transferred coordinator domain; and
- an append-only `audit` event list. Every event has time, actor session when applicable, action, changed values/identifiers, and one decision reference.

The built-in `explicit-lifecycle` adapter retains the supplied work-item ID, path, and lifecycle. **It does not synchronize an external tracker.**

A v1 record is converted under the existing atomic transaction lock and persisted as v2 on that write. The conversion adds exactly one `legacy-import` event per defect, preserves raw evidence and historical snapshots as audit events, records a legacy `ownerPocSessionId` only inside that import event, and never makes it live authority or fills in an absent source domain. Migrated records fail release checks until newly scoped lead evidence exists.

## Authorization and safety

- Manager sessions come only from `ctx.sessionManager.getSessionId()`; displayed Manager names are resolved from Pi session names and are never persisted in TTR.
- The active Manager registered for `coordinatorDomain` authorizes all work-item transitions and evidence writes. Replacing or deactivating that Manager changes authority dynamically without changing report provenance.
- Explicit active TTR admins (bootstrapped through `TTR_ADMIN_SESSION_IDS`) alone can transfer a coordinator. Transfer validates the target domain has an active Manager, changes only `coordinatorDomain`, and appends audit.
- A contributor may be added or removed only by the coordinator. Any non-lead work-item reference may be removed by that coordinator with an audited decision; the lead cannot be removed, but an active admin may explicitly move it to the coordinator domain.
- Work-item IDs and paths are globally collision-checked across all defect scopes.
- Validation, review, commit, deployment, and requester-message evidence require `workItemDomain`. Release gates use only the lead work-item scope; contributor evidence never satisfies a lead release gate.
- The supported release gate still requires a lead item, clean tree, validation/review/commit evidence, and (when required) deployment evidence, a final lead transition, and a distinct final post-deployment commit.

Do not edit `state.json` directly. TTR has no external transport: requester-message tools only record an allowed message with `delivery: "not-delivered"`.

## Commands

```text
/ttr register [domain ...] [--replace]
/ttr register --admin [session-id]
/ttr status [domain] [--json]
/ttr list [--active] [--json]
/ttr list [--active] --select  # select a registered persisted Pi session, then resume it here
/ttr list --admin
/ttr restore                    # reopen active registered Manager sessions in stacked panes under Zellij tab `ttr`
/ttr ui                         # inspect a defect or transfer coordinator as admin
/ttr unregister [domain] [--all]
/ttr unregister <session-id> --admin
/ttr deactivate [domain]
```

`/ttr restore` is read-only with respect to TTR state. It requires persisted Pi sessions and a live Zellij parent. In an existing `ttr` tab it keeps verified live `pi --session` panes, replaces an unambiguous exited pane with the matching session, creates stacked panes for missing sessions, then fails clearly unless every active registered Manager session is verified live.

## Tool flow

```ts
// Owner is a boundary compatibility alias only in older callers. New calls use coordinatorDomain.
ttr_intake_for_owner({
  reporter: "customer", source: "support:123", sourceDomain: "storefront",
  coordinatorDomain: "payments", symptom: "card declined", impact: "checkout blocked",
  environment: "prod", reproduction: "submit card", evidenceReferences: ["ticket:123"]
})

ttr_assign_work_item({
  defectId: "ttr-…", workItemDomain: "payments", workItemId: "PAY-123",
  workItemPath: "backlog/PAY-123.md", status: "in-progress",
  lifecycleStates: ["proposed", "in-progress", "closed"]
})
ttr_add_contributing_domains({ defectId: "ttr-…", domains: ["operations"] })
ttr_assign_work_item({
  defectId: "ttr-…", workItemDomain: "operations", workItemId: "OPS-9",
  workItemPath: "ops/OPS-9.md", status: "proposed", lifecycleStates: ["proposed", "closed"]
})
// Any non-lead reference may be removed only by the coordinator, with an auditable decision.
ttr_remove_contributor_work_item({ defectId: "ttr-…", workItemDomain: "operations", decisionReference: "decision:no-longer-needed" })

// Admin only; coordinator transfer leaves the lead reference unchanged.
ttr_transfer_coordinator({ defectId: "ttr-…", targetDomain: "risk", decisionReference: "decision:42" })
// Use this only when the existing lead tracker belongs to the new coordinator domain.
// It moves the reference; it does not replace a tracker or create a domain alias.
ttr_transfer_lead_work_item_domain({ defectId: "ttr-…", targetDomain: "risk", decisionReference: "decision:move-lead" })
ttr_add_contributing_domains({ defectId: "ttr-…", domains: ["operations"] })
ttr_assign_work_item({ defectId: "ttr-…", workItemDomain: "operations", workItemId: "OPS-1", workItemPath: "ops/OPS-1.md", status: "proposed", lifecycleStates: ["proposed", "closed"] })
ttr_remove_contributor_work_item({ defectId: "ttr-…", workItemDomain: "operations", decisionReference: "decision:remove-operations-reference" })

ttr_record_evidence({ defectId: "ttr-…", workItemDomain: "payments", type: "validation", status: "passed", path: "evidence/test.txt" })
ttr_record_evidence({ defectId: "ttr-…", workItemDomain: "payments", type: "review", status: "passed", path: "evidence/review.md" })
ttr_record_commit_evidence({ defectId: "ttr-…", workItemDomain: "payments", sha: "<sha>", phase: "pre-deployment", path: "evidence/commit.json" })
ttr_check_release_gate({ defectId: "ttr-…", workItemDomain: "payments", deploymentRequired: false })
```

## Test

```bash
node --import tsx --test test/triage-control-plane.test.mjs test/triage-control-plane-core.test.mjs test/triage-control-plane-commands.test.mjs
pnpm check
git diff --check
```
