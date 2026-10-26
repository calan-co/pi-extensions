# TTR Pi Durable Service Migration

## Decision

TTR will evolve from a Pi-extension control plane plus operator sessions into a hosted, domain-scoped service built on `@earendil-works/pi-durable`.

Pi Durable owns durable conversations and resumable task execution. TTR owns canonical defect state, domain policy, authorization, routing, evidence, and release decisions. A transcript, summary, fork, or model output never grants authority.

The current Pi extension remains the compatibility surface during migration. Zellij is not part of the target architecture.

## Target shape

One service process initially opens a SQLite-backed Pi Durable harness. Each domain has a durable conversation with a versioned domain manifest:

- repository boundary and coding standards;
- approved skills, tools, routing criteria, and workflow instructions;
- a content hash recorded with every triage decision.

TTR state is stored as typed Pi Durable documents and changed only in atomic commits with the associated audit event. The minimum documents are a domain registry, defect records, work-item/evidence references, and an outbox of external effects. A read-only process may inspect the store, but only the elected service process resumes work or mutates it.

Inbound adapters admit idempotent reports. Deterministic policy selects an eligible domain before an LLM triages the report. The selected domain agent may recommend a route; TTR validates the route, authorization, repository boundary, and workflow policy before committing it.

External effects are an outbox task with stable idempotency keys and recorded receipts. A tool is replay-safe only when it is demonstrably idempotent. Repository edits, deployments, requester messages, and tracker writes default to non-replay-safe and require an explicit receipt before retry.

## Migration stages

1. **Foundation spike** — create a separate service module with SQLite storage, a typed TTR document schema, one read-only status endpoint, and a compatibility importer. Prove crash-resume, idempotent intake, and read-only inspection. No live routing.
2. **Single-domain pilot** — run one explicitly selected domain through the service. Load its manifest on every task, enforce repository scope, and route only to a no-op/outbox adapter. Compare every decision with the existing extension.
3. **Controlled write path** — enable TTR mutations and one idempotent external adapter behind a domain allowlist. Keep the Pi extension as fallback and preserve its state until equivalence is demonstrated.
4. **Domain workers** — add domain manifests, policy-selected specialist workers, coding-work adapters, and operational telemetry. Workers cannot directly transfer authority or bypass the outbox.
5. **Cutover** — migrate active records with immutable source references, make the service authoritative, and retire the Zellij/session-management surface only after rollback has expired.

Each stage is a separate Doc-Vader work item with a passing focused test suite, a migration receipt, and a rollback procedure. Do not begin a later stage while its predecessor lacks those artifacts.

## Acceptance seams

- **Core document API:** atomic state/audit commits, current policy validation, idempotent intake, and replay classification.
- **Service tool/API boundary:** a durable task loads the current manifest, enforces domain/repository scope, writes an outbox receipt, and rejects unauthorized or stale mutations.
- **Compatibility adapter:** imports current TTR state without making Pi session metadata authoritative.

## Non-goals

- Treating Pi Durable transcripts as the TTR authority model.
- Replaying external side effects solely because a task resumed.
- Replacing every existing Pi-extension command in the first migration stage.
- Supporting multiple active writers to one SQLite store.

## Rollback

Before cutover, the current Pi extension remains read/write authoritative and the service runs in shadow mode. After cutover, retain an immutable export and a verified importer back to the extension format until the rollback window closes. Do not delete the old state as part of migration.
