# Triage Control Plane (TTR)

Global Pi extension implementing the structured control-plane portions of `~/.agents/skills/bug-report-response/SKILL.md`. The skill remains responsible for triage, diagnosis, TDD, review, and orchestration behaviour; this extension tracks authoritative state and supported gates.

## Purpose

TTR makes the protocol's control plane durable and inspectable without replacing the policy skill or automating unsafe external actions. It answers four control questions before work advances:

1. **Who owns this defect domain?** The active designated Manager.
2. **What is the single tracking authority?** The defect's one authoritative work item.
3. **What evidence supports the next transition?** Linked intake, validation, review, commit, deployment, and requester-message evidence.
4. **May a supported release or safe-to-proceed action advance?** Only if the fail-closed release gate passes.

## Architecture

```mermaid
flowchart TD
  Skill["bug-report-response skill\nbehavioural protocol"] --> Intake[ttr_intake]
  Intake --> Registry["Manager registry\natomic global state"]
  Intake --> Defect["Defect record\nowner + intake evidence"]
  Defect --> WorkItem["One authoritative work item\nexplicit lifecycle adapter"]
  WorkItem --> Lane[ttr_prepare_work_lane]
  Lane --> Evidence["Linked evidence\nvalidation • review • commits"]
  Evidence --> Deployment["Deployment evidence\nartifact + receipt + verification"]
  Deployment --> FinalUpdate["Final work-item update\nsecond, distinct commit receipt"]
  FinalUpdate --> Gate[ttr_check_release_gate]
  Gate --> Message["ttr_send_requester_message\nrecords only; no transport"]
```

### Components

| Component | Responsibility |
| --- | --- |
| `index.ts` | Pi command and custom-tool registration; retrieves the supported Pi session ID and performs cwd-aware Git inspection. |
| `src/core.ts` | Testable domain model, atomic lock/file storage, Manager resolution, work-item invariants, evidence recording, and release-gate logic. |
| `explicit-lifecycle` adapter | Stores caller-configured repository lifecycle states. It does not infer statuses or edit repository backlog files. |
| `README.md` | Operational contract, boundaries, installation, and examples. |

## State and safety

- Durable global state: `$PI_CODING_AGENT_DIR/triage-control-plane/state.json` (default `~/.pi/agent/triage-control-plane/state.json`), written through an exclusive lock plus atomic temp-file rename with restrictive permissions.
- Manager session IDs come from `ctx.sessionManager.getSessionId()` (the documented session API); `/ttr register` never guesses one.
- Pi provides `ctx.cwd`, but no semantic domain API. When omitted from a TTR command, the domain is deterministically derived from the Git repository root name, falling back to the current directory name; supply a domain explicitly to override it.
- Incoming `ttr_intake` reports must separately declare `sourceDomain`, `ownerDomain`, and `targetPocSessionId` (the retained compatibility field name for the target Manager). `ttr_intake_for_owner` keeps `sourceDomain` and `ownerDomain` explicit but atomically resolves the active target Manager. Neither tool infers ownership from the sender workspace or source domain.
- Secrets are not accepted in records or tools. Store only evidence references/paths, receipts, and commit SHA evidence.
- The built-in `explicit-lifecycle` adapter stores the caller-supplied lifecycle states alongside the authoritative ID/path. It intentionally does **not** invent repository status names or mutate a repository work item. A repository integration can implement the exported `WorkItemAdapter` seam.

## Enforcement boundaries

Enforced by supported TTR tools:

- one active Manager registration per canonical domain or alias, with atomic multi-alias registration and explicit confirmation before active Manager replacement; aliases are stored as a compact index to one canonical Manager record, and legacy same-session records are consolidated on read;
- evidence-only handoff generation when the resolved owner Manager, declared target Manager, and receiving session do not all match;
- `ttr_prepare_work_lane` refuses to produce a supported diagnosis/review/validation/implementation lane contract until the authoritative work item exists, and its emitted preamble must be passed to the lane;
- exactly one authoritative work-item reference per TTR defect, and only its configured lifecycle states;
- reassignment only by the active, addressed owner Manager, with a nonempty replacement ID/path/status/lifecycle, no same or colliding assignment, and append-only prior-item audit history containing a reason and evidence references;
- requester-message category validation and evidence recording;
- release-gate checks for authoritative item, clean Git tree, commit/validation/review evidence, deployment artifact/receipt/verification, final post-deployment item update, and linked **distinct** second commit evidence;
- `safe-to-proceed` only after the supported gate passes.

Not enforceable globally:

- direct arbitrary `subagent` calls cannot be reliably associated with a defect, so the extension cannot truthfully block every lane launched outside `ttr_prepare_work_lane`;
- generic inbound `intercom` messages cannot be intercepted by this extension. Pi-intercom injects them into a recipient through its own private inbound handler. The extension bus is opaque extension-channel traffic, not a generic-message hook.
- the extension does not attempt heuristic blocking of arbitrary `bash`, `user_bash`, deploy, publish, or manual messaging commands. Those paths may be warned about by process policy but cannot be truthfully claimed as fully blocked.
- `ttr_send_requester_message` records a permitted message only. It has **no external transport** and never sends email, chat, comments, deployments, publications, or releases.
- a clean Git tree and linked SHA evidence prove supported gate prerequisites, but cannot prove that arbitrary hidden/external changes are in scope. Deployment authorization remains human/repository process authority.

### Sender-side non-Manager handoff contract

`ttr_intake` returns a `targetSessionId`, `delivery: "not-attempted"`, and the minimal evidence-only payload. If and only if the Manager session is a known established reachable channel, use exactly the target emitted by the tool:

```ts
intercom({ action: "send", to: "<returned targetSessionId>", message: "<returned payload JSON>" })
```

Do not substitute a name, fabricate a target, or silently reroute an unreachable Manager. If reachability is unknown, keep the payload in TTR state and request an authorized replacement route.

## Commands

```text
/ttr register                                            # register this session as Manager for the current repository domain
/ttr register payments                                   # this session is Manager for an explicit domain
/ttr register pi-extensions ttr agent-workflows handoff  # register the same Manager for a canonical domain plus aliases
/ttr register payments --session-id <pi-session-id>      # explicit Manager; positional values remain domains/aliases
/ttr register payments ttr --replace                     # required to replace any active Manager in the set
/ttr manager                                             # inspect the Manager for the current repository domain
/ttr manager payments
/ttr managers                                            # JSON: active canonical Managers
/ttr list                                                # table: friendly Manager name, domains, aliases, and active status
/ttr unregister payments                                 # remove one domain; promotes another alias if needed
/ttr unregister payments --all                           # remove the entire Manager and every domain alias
/ttr deactivate                                          # deactivate the Manager for the current repository domain
/ttr deactivate payments
```

## Tool examples

```ts
// Record intake. `sourceDomain` is evidence context; only `ownerDomain` selects the TTR Manager.
// A receiver may start a supported lane only when targetPocSessionId resolves to that same receiver.
ttr_intake({
  reporter: "customer", source: "support:123", sourceDomain: "storefront",
  ownerDomain: "payments", targetPocSessionId: "<addressed-poc-session-id>",
  symptom: "card declined", impact: "checkout blocked", environment: "prod",
  reproduction: "submit Visa test card", evidenceReferences: ["ticket:123", "request:req-7"]
})

// Preferred when the owner domain is known: resolve its active Manager without copying a session ID.
// Fails with `/ttr register payments` guidance when no active Manager exists.
ttr_intake_for_owner({
  reporter: "customer", source: "support:123", sourceDomain: "storefront", ownerDomain: "payments",
  symptom: "card declined", impact: "checkout blocked", environment: "prod",
  reproduction: "submit Visa test card", evidenceReferences: ["ticket:123", "request:req-7"]
})

// One-time explicit migration for a legacy record created before the routing contract.
// Only the active owner Manager named by targetPocSessionId can re-attest it.
ttr_reattest_defect_authority({
  defectId: "ttr-…", sourceDomain: "babysitter-dv", ownerDomain: "ttr",
  targetPocSessionId: "<active-ttr-poc-session-id>"
})

// Before any diagnosis/design/implementation/review/validation/deployment lane:
ttr_assign_work_item({
  defectId: "ttr-…", workItemId: "BUG-123", workItemPath: "backlog/BUG-123.md",
  status: "in-progress", lifecycleStates: ["proposed", "in-progress", "ready-for-review", "closed"]
})

// Only the active, addressed owner Manager may replace an authoritative item. TTR preserves BUG-123 in immutable audit history.
ttr_reassign_work_item({
  defectId: "ttr-…", workItemId: "BUG-456", workItemPath: "backlog/BUG-456.md",
  status: "proposed", lifecycleStates: ["proposed", "in-progress", "closed"],
  reason: "duplicate tracker item", evidenceReferences: ["ticket:123"]
})

// Required supported-lane preamble to pass into any diagnosis/review/validation/implementation lane:
ttr_prepare_work_lane({ defectId: "ttr-…", lane: "diagnosis" })

ttr_record_evidence({ defectId: "ttr-…", type: "validation", status: "passed", path: "evidence/repro.txt" })
ttr_record_evidence({ defectId: "ttr-…", type: "review", status: "passed", path: "evidence/review.md" })
ttr_record_commit_evidence({ defectId: "ttr-…", sha: "<commit-sha>", phase: "pre-deployment", path: "evidence/commit.json" })

// Records evidence for an already-authorized deployment; it never deploys.
ttr_record_deployment_evidence({ defectId: "ttr-…", artifact: "app@1.2.3", receipt: "deploy:42", verification: "healthcheck passed" })
ttr_transition_work_item({ defectId: "ttr-…", status: "closed", nextAction: "none" })
ttr_record_commit_evidence({ defectId: "ttr-…", sha: "<final-work-item-update-sha>", phase: "post-deployment", path: "evidence/final-commit.json" })
ttr_check_release_gate({ defectId: "ttr-…", deploymentRequired: true })

// Records an allowed message; it deliberately does not transmit it.
ttr_send_requester_message({ defectId: "ttr-…", category: "safe-to-proceed", message: "You may proceed. Monitoring is healthy.", deploymentRequired: true })
```

## Installation/reload

This extension is loaded through this package's `pi.extensions` manifest entry:

```text
extensions/triage-control-plane/index.ts
```

Install or link the `pi-extensions` package in Pi, then restart Pi or run `/reload`. For isolated load testing from the repository root:

```bash
pi -e extensions/triage-control-plane/index.ts
```

## Test

```bash
cd /path/to/pi-extensions
node --import tsx --test test/triage-control-plane.test.mjs test/triage-control-plane-core.test.mjs
```
