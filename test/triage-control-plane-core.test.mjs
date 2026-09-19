import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriageControlPlane } from "../extensions/triage-control-plane/src/core.ts";

async function setup() { const dir = await mkdtemp(join(tmpdir(), "ttr-core-")); return { statePath: join(dir, "state.json") }; }
const item = (id, path, status = "proposed") => ({ id, path, status, lifecycleStates: ["proposed", "in-progress", "closed"] });
const intake = (coordinatorDomain = "payments", currentSessionId = "payments-manager") => ({ reporter: "customer", source: "support:1", sourceDomain: "storefront", coordinatorDomain, symptom: "declined", impact: "checkout", environment: "prod", reproduction: "submit card", evidenceReferences: ["ticket:1"], currentSessionId });

test("v1 migration is idempotent, preserves provenance gaps, and adds one legacy-import event", async () => {
  const { statePath } = await setup();
  await writeFile(statePath, JSON.stringify({ version: 1, registrations: {}, defects: { "ttr-old": { id: "ttr-old", domain: "payments", ownerPocSessionId: "retired-manager", intake: { reporter: "r", source: "s", recordedAt: "2026-01-01T00:00:00.000Z" }, workItem: { ...item("OLD-1", "old.md"), adapter: "explicit-lifecycle" }, evidence: [] } } }));
  const plane = new TriageControlPlane({ statePath });
  const migrated = await plane.getDefect("ttr-old");
  assert.equal(migrated.report.sourceDomain, undefined);
  assert.equal(migrated.audit.filter(event => event.action === "legacy-import").length, 1);
  assert.equal(migrated.audit[0].changed.legacyOwnerPocSessionId, "retired-manager");
  assert.equal("ownerPocSessionId" in migrated, false);
  await plane.setSessionNaming("s", true); // transaction persists v2 conversion
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.defects["ttr-old"].audit.filter(event => event.action === "legacy-import").length, 1);
  assert.equal(stored.defects["ttr-old"].audit[0].changed.legacyOwnerPocSessionId, "retired-manager");
  assert.equal("ownerPocSessionId" in stored.defects["ttr-old"], false);
});

test("coordinator is dynamically resolved and transfer preserves immutable report and work references", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, bootstrapAdminSessionIds: ["admin"] });
  await plane.registerPoc("payments", { sessionId: "payments-manager" }, false);
  await plane.registerPoc("risk", { sessionId: "risk-manager" }, false);
  await plane.registerAdmin("admin", "admin");
  const { defect } = await plane.intakeForOwner(intake());
  await plane.assignWorkItem(defect.id, "payments", item("PAY-1", "pay.md"), "payments-manager");
  await plane.registerPoc("payments", { sessionId: "replacement-manager" }, true);
  await assert.rejects(() => plane.transitionWorkItem(defect.id, "payments", "in-progress", {}, "payments-manager"), /not authorized/i);
  await plane.transitionWorkItem(defect.id, "payments", "in-progress", {}, "replacement-manager");
  const moved = await plane.transferCoordinator(defect.id, "risk", "decision:42", "admin");
  assert.equal(moved.coordinatorDomain, "risk");
  assert.deepEqual(moved.report, defect.report);
  assert.equal(moved.workItems.payments.id, "PAY-1");
  assert.equal(moved.audit.at(-1).action, "coordinator-transferred");
  const withNewCoordinatorReference = await plane.assignWorkItem(defect.id, "risk", item("RISK-1", "risk.md"), "risk-manager");
  assert.equal(withNewCoordinatorReference.leadWorkItemDomain, "payments", "transfer keeps the original lead stable");
  await plane.removeContributorWorkItem(defect.id, "risk", "decision:remove-risk-reference", "risk-manager");
  assert.equal((await plane.getDefect(defect.id)).workItems.risk, undefined);
  await assert.rejects(() => plane.transitionWorkItem(defect.id, "payments", "closed", {}, "replacement-manager"), /not authorized/i);
  await plane.transitionWorkItem(defect.id, "payments", "closed", {}, "risk-manager");
});

test("lead and contributor work items are scoped, globally collision-safe, and audit replacements", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("payments", { sessionId: "payments-manager" }, false);
  const { defect } = await plane.intakeForOwner(intake());
  await assert.rejects(() => plane.assignWorkItem(defect.id, "ops", item("OPS-1", "ops.md"), "payments-manager"), /not a contributor/i);
  await plane.assignWorkItem(defect.id, "payments", item("PAY-1", "pay.md"), "payments-manager");
  await plane.addContributingDomains(defect.id, ["ops", "docs", "ops"], "payments-manager");
  const updated = await plane.assignWorkItem(defect.id, "ops", item("OPS-1", "ops.md"), "payments-manager");
  assert.equal(updated.leadWorkItemDomain, "payments");
  assert.equal(updated.workItems.ops.id, "OPS-1");
  const reassigned = await plane.reassignWorkItem(defect.id, "ops", item("OPS-2", "ops-2.md"), { reason: "tracker duplicate", evidenceReferences: ["ticket:2"] }, "payments-manager");
  assert.equal(reassigned.audit.at(-1).changed.previousWorkItem.id, "OPS-1");
  await plane.removeContributorWorkItem(defect.id, "ops", "decision:remove-ops", "payments-manager");
  assert.equal((await plane.getDefect(defect.id)).workItems.ops, undefined);
  const { defect: other } = await plane.intakeForOwner({ ...intake(), symptom: "other" });
  await assert.rejects(() => plane.assignWorkItem(other.id, "payments", item("PAY-1", "other.md"), "payments-manager"), /already authoritative/i);
});

test("an admin moves the lead work-item scope to the transferred coordinator without copying it", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, bootstrapAdminSessionIds: ["admin"] });
  await plane.registerPoc("payments", { sessionId: "payments-manager" }, false);
  await plane.registerPoc("homelab-ansible", { sessionId: "ansible-manager" }, false);
  await plane.registerAdmin("admin", "admin");
  const { defect } = await plane.intakeForOwner(intake());
  await plane.assignWorkItem(defect.id, "payments", item("PAY-1", "pay.md"), "payments-manager");
  await plane.transferCoordinator(defect.id, "homelab-ansible", "decision:coordinator", "admin");

  const moved = await plane.transferLeadWorkItemDomain(defect.id, "homelab-ansible", "decision:move-lead", "admin");
  assert.equal(moved.leadWorkItemDomain, "homelab-ansible");
  assert.equal(moved.workItems["homelab-ansible"].id, "PAY-1");
  assert.equal(moved.workItems.payments, undefined);
  assert.equal(moved.audit.at(-1).action, "lead-work-item-domain-transferred");
  await plane.transitionWorkItem(defect.id, "homelab-ansible", "in-progress", {}, "ansible-manager");
});

test("release evidence and gate are limited to the lead work item", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, git: async () => ({ clean: true, head: "pre" }) });
  await plane.registerPoc("payments", { sessionId: "payments-manager" }, false);
  const { defect } = await plane.intakeForOwner(intake());
  await plane.assignWorkItem(defect.id, "payments", item("PAY-1", "pay.md", "in-progress"), "payments-manager");
  await plane.addContributingDomains(defect.id, ["ops"], "payments-manager");
  await plane.assignWorkItem(defect.id, "ops", item("OPS-1", "ops.md"), "payments-manager");
  await plane.recordEvidence(defect.id, { type: "validation", status: "passed", workItemDomain: "ops" }, "payments-manager");
  await plane.recordEvidence(defect.id, { type: "review", status: "passed", workItemDomain: "ops" }, "payments-manager");
  await plane.recordCommitEvidence(defect.id, { sha: "ops", phase: "other", path: "ops.json", workItemDomain: "ops" }, "payments-manager");
  const gate = await plane.checkReleaseGate(defect.id, { deploymentRequired: false, workItemDomain: "payments" });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing.filter(value => value.endsWith("evidence")), ["commit-evidence", "validation-evidence", "review-evidence"]);
  await assert.rejects(() => plane.recordDeploymentEvidence(defect.id, { workItemDomain: "ops", artifact: "x", receipt: "r", verification: "ok" }, "payments-manager"), /lead work item/i);
});
