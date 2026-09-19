import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriageControlPlane } from "../extensions/triage-control-plane/src/core.ts";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ttr-core-"));
  return { dir, statePath: join(dir, "state.json") };
}

const poc = { sessionId: "poc-session-123", projectBoundary: "/repo", requesterChannel: "issue:42" };

test("POC registration persists, resolves, and needs explicit replacement confirmation", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, now: () => "2026-01-01T00:00:00.000Z" });
  const registered = await plane.registerPoc("payments", poc, false);
  assert.equal(registered.active, true);
  assert.equal((await plane.resolvePoc("payments"))?.sessionId, poc.sessionId);

  await assert.rejects(() => plane.registerPoc("payments", { sessionId: "other" }, false), /explicit replacement confirmation/i);
  await plane.registerPoc("payments", { sessionId: "other" }, true);
  assert.equal((await plane.resolvePoc("payments"))?.sessionId, "other");

  const reloaded = new TriageControlPlane({ statePath });
  assert.equal((await reloaded.resolvePoc("payments"))?.sessionId, "other");
  await reloaded.deactivatePoc("payments");
  assert.equal(await reloaded.resolvePoc("payments"), undefined);
  assert.match(await readFile(statePath, "utf8"), /payments/);
});

test("POC aliases register atomically and resolve to the same session", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  const records = await plane.registerPocs(["pi-extensions", "ttr", "agent-workflows", "handoff"], poc, false);

  assert.deepEqual(records.map(record => record.domain), ["pi-extensions", "ttr", "agent-workflows", "handoff"]);
  for (const domain of records.map(record => record.domain)) {
    assert.equal((await plane.resolvePoc(domain))?.sessionId, poc.sessionId);
  }
  assert.deepEqual(await plane.listPocs(), [{ ...records[0], aliases: records.map(record => record.domain).sort() }]);
});

test("a Manager receives one friendly name shared by every alias", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, random: () => 0 });
  await plane.registerPocs(["payments", "billing"], poc, false);

  const [manager] = await plane.listPocs();
  assert.equal(manager.managerName, "Avery");
  assert.deepEqual(manager.aliases, ["billing", "payments"]);
});

test("unregister removes one domain or an entire Manager registration", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPocs(["payments", "billing"], poc, false);

  assert.deepEqual((await plane.unregisterPoc("payments")).removedDomains, ["payments"]);
  assert.equal(await plane.resolvePoc("payments"), undefined);
  assert.equal((await plane.resolvePoc("billing"))?.domain, "billing");
  assert.deepEqual((await plane.listPocs()).map(({ domain, aliases }) => ({ domain, aliases })), [{ domain: "billing", aliases: ["billing"] }]);

  assert.deepEqual((await plane.unregisterPoc("billing", true)).removedDomains, ["billing"]);
  assert.deepEqual(await plane.listPocs(true), []);
});

test("legacy per-alias records compact on the next write without breaking routing", async () => {
  const { statePath } = await setup();
  const legacyRecord = { domain: "payments", canonicalDomain: "payments", ...poc, registeredAt: "2026-01-01T00:00:00.000Z", active: true };
  await writeFile(statePath, JSON.stringify({
    version: 1, defects: {}, registrations: {
      payments: legacyRecord,
      billing: { ...legacyRecord, domain: "billing" },
    },
  }));
  const plane = new TriageControlPlane({ statePath });

  assert.equal((await plane.resolvePoc("billing"))?.sessionId, poc.sessionId);
  await plane.deactivatePoc("billing");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(Object.keys(persisted.registrations), ["payments"]);
  assert.deepEqual(persisted.aliases, { payments: "payments", billing: "payments" });
  assert.equal((await plane.resolvePoc("payments")), undefined);
});

test("legacy self-canonical aliases for one POC collapse into one listing", async () => {
  const { statePath } = await setup();
  const payments = { domain: "payments", canonicalDomain: "payments", ...poc, registeredAt: "2026-01-01T00:00:00.000Z", active: true };
  await writeFile(statePath, JSON.stringify({
    version: 1, defects: {}, aliases: { payments: "payments", billing: "billing" }, registrations: {
      payments,
      billing: { ...payments, domain: "billing", canonicalDomain: "billing", projectBoundary: "/other-repo" },
    },
  }));
  const plane = new TriageControlPlane({ statePath });

  const [manager] = await plane.listPocs();
  assert.equal(manager.domain, "payments");
  assert.deepEqual(manager.aliases, ["billing", "payments"]);
  assert.equal(typeof manager.managerName, "string");
  assert.equal((await plane.resolvePoc("billing"))?.domain, "payments");
});

test("non-POC intake produces an evidence-only handoff and does not claim delivery", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("payments", poc, false);
  const intake = await plane.intake({
    reporter: "customer", source: "support", sourceDomain: "support", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "card declined", impact: "checkout blocked",
    environment: "prod", reproduction: "submit card", evidenceReferences: ["ticket:123"], currentSessionId: "other-session",
  });
  assert.equal(intake.role, "non-poc");
  assert.equal(intake.handoff?.targetSessionId, poc.sessionId);
  assert.equal(intake.handoff?.delivery, "not-attempted");
  assert.deepEqual(Object.keys(intake.handoff.payload).sort(), ["defectId", "domain", "evidenceReferences", "impact", "sourceDomain", "symptom"]);
});

test("owner-resolved intake obtains its target from the active owner POC", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("payments", poc, false);

  const input = {
    reporter: "customer", source: "support", sourceDomain: "storefront", ownerDomain: "payments",
    symptom: "card declined", impact: "checkout blocked", environment: "prod", reproduction: "submit card", evidenceReferences: [], currentSessionId: poc.sessionId,
  };
  const intake = await plane.intakeForOwner(input);

  assert.equal(intake.role, "poc");
  assert.equal(intake.defect.intake.targetPocSessionId, poc.sessionId);
  await assert.rejects(
    () => plane.intakeForOwner({ ...input, ownerDomain: "missing" }),
    /No active POC registration for missing; run \/ttr register missing/,
  );
});

test("intake separates source from owner domain and fail-closes a target-POC mismatch", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("ttr", poc, false);
  const input = {
    reporter: "validator", source: "intercom", sourceDomain: "babysitter-dv", ownerDomain: "ttr", targetPocSessionId: poc.sessionId,
    symptom: "routing mismatch", impact: "incorrect ownership", environment: "test", reproduction: "send cross-domain defect", evidenceReferences: [], currentSessionId: poc.sessionId,
  };

  const confirmed = await plane.intake(input);
  assert.equal(confirmed.role, "poc");
  assert.equal(confirmed.defect.domain, "ttr");
  assert.equal(confirmed.defect.intake.sourceDomain, "babysitter-dv");
  assert.equal(confirmed.defect.intake.targetPocSessionId, poc.sessionId);

  const mismatched = await plane.intake({ ...input, targetPocSessionId: "different-session" });
  assert.equal(mismatched.role, "non-poc");
  assert.equal(mismatched.handoff?.targetSessionId, poc.sessionId);
  await assert.rejects(
    () => plane.assignWorkItem(mismatched.defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "proposed", lifecycleStates: ["proposed"] }, poc.sessionId),
    /not authorized to assign a work item/i,
  );
});

test("a registered owner POC can explicitly re-attest a legacy defect", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("ttr", poc, false);
  const { defect } = await plane.intake({
    reporter: "validator", source: "intercom", sourceDomain: "babysitter-dv", ownerDomain: "ttr", targetPocSessionId: poc.sessionId,
    symptom: "legacy authority missing", impact: "lane blocked", environment: "test", reproduction: "load legacy state", evidenceReferences: [], currentSessionId: poc.sessionId,
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.defects[defect.id].intake.sourceDomain;
  delete state.defects[defect.id].intake.targetPocSessionId;
  delete state.defects[defect.id].intake.authorityConfirmed;
  await writeFile(statePath, `${JSON.stringify(state)}\n`);

  const reattested = await plane.reattestDefectAuthority(defect.id, {
    sourceDomain: "babysitter-dv", ownerDomain: "ttr", targetPocSessionId: poc.sessionId, actorSessionId: poc.sessionId,
  });
  assert.equal(reattested.intake.authorityConfirmed, true);
  assert.equal(reattested.intake.sourceDomain, "babysitter-dv");
  assert.equal(await plane.ensurePocAuthority(defect.id, poc.sessionId).then(item => item.id), defect.id);
});

test("a defect has one authoritative work item and only configured lifecycle transitions", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("payments", poc, false);
  const { defect } = await plane.intake({ reporter: "r", source: "s", sourceDomain: "s", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "x", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [], currentSessionId: poc.sessionId });
  await plane.assignWorkItem(defect.id, { id: "BUG-1", path: "backlog/BUG-1.md", status: "proposed", lifecycleStates: ["proposed", "in-progress", "closed"] }, poc.sessionId);
  await assert.rejects(() => plane.assignWorkItem(defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "proposed", lifecycleStates: ["proposed"] }, poc.sessionId), /already has an authoritative/i);
  await assert.rejects(() => plane.transitionWorkItem(defect.id, "blocked"), /not configured/i);
  const updated = await plane.transitionWorkItem(defect.id, "in-progress", { blocker: "awaiting logs", nextAction: "request logs" });
  assert.equal(updated.workItem?.status, "in-progress");
  assert.equal(updated.blocker, "awaiting logs");
});

test("an active authorized defect owner can reassign a work item with immutable audit history", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, now: () => "2026-01-02T00:00:00.000Z" });
  await plane.registerPoc("payments", poc, false);
  const { defect } = await plane.intake({ reporter: "r", source: "s", sourceDomain: "s", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "x", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [], currentSessionId: poc.sessionId });
  await plane.assignWorkItem(defect.id, { id: "BUG-1", path: "backlog/BUG-1.md", status: "proposed", lifecycleStates: ["proposed", "in-progress"] }, poc.sessionId);

  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "proposed", lifecycleStates: ["proposed"] }, { reason: "duplicate issue", evidenceReferences: ["ticket:123"] }, "other-session"), /not authorized to reassign a work item/i);
  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "proposed", lifecycleStates: ["proposed"] }, { reason: "", evidenceReferences: [] }, poc.sessionId), /reason and evidence references are required/i);
  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "", path: "", status: "", lifecycleStates: [] }, { reason: "duplicate issue", evidenceReferences: ["ticket:123"] }, poc.sessionId), /id, path, status, and configured lifecycleStates are required/i);
  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "closed", lifecycleStates: ["proposed"] }, { reason: "duplicate issue", evidenceReferences: ["ticket:123"] }, poc.sessionId), /status must be in configured lifecycleStates/i);
  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "BUG-1", path: "backlog/BUG-1.md", status: "proposed", lifecycleStates: ["proposed"] }, { reason: "duplicate issue", evidenceReferences: ["ticket:123"] }, poc.sessionId), /same as the authoritative work item/i);

  const reassigned = await plane.reassignWorkItem(defect.id, { id: "BUG-2", path: "backlog/BUG-2.md", status: "in-progress", lifecycleStates: ["proposed", "in-progress"] }, { reason: "duplicate issue", evidenceReferences: ["ticket:123"] }, poc.sessionId);
  assert.equal(reassigned.workItem?.id, "BUG-2");
  assert.deepEqual(reassigned.workItemHistory, [{ previousWorkItem: { id: "BUG-1", path: "backlog/BUG-1.md", adapter: "explicit-lifecycle", status: "proposed", lifecycleStates: ["proposed", "in-progress"] }, reason: "duplicate issue", evidenceReferences: ["ticket:123"], reassignedAt: "2026-01-02T00:00:00.000Z" }]);

  const { defect: otherDefect } = await plane.intake({ reporter: "r", source: "s", sourceDomain: "s", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "y", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [], currentSessionId: poc.sessionId });
  await plane.assignWorkItem(otherDefect.id, { id: "BUG-3", path: "backlog/BUG-3.md", status: "proposed", lifecycleStates: ["proposed"] }, poc.sessionId);
  await assert.rejects(() => plane.reassignWorkItem(defect.id, { id: "BUG-4", path: "backlog/BUG-3.md", status: "proposed", lifecycleStates: ["proposed"] }, { reason: "wrong queue", evidenceReferences: ["ticket:456"] }, poc.sessionId), /already authoritative for defect/i);
});

test("requester-message categories reject noise and record accepted message evidence", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath });
  await plane.registerPoc("payments", poc, false);
  const { defect } = await plane.intake({ reporter: "r", source: "s", sourceDomain: "s", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "x", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [], currentSessionId: poc.sessionId });
  await assert.rejects(() => plane.recordRequesterMessage(defect.id, "progress-update", "still looking"), /unsupported requester-message category/i);
  const evidence = await plane.recordRequesterMessage(defect.id, "request-logs", "Please provide request id.");
  assert.equal(evidence.type, "requester-message");
  assert.equal(evidence.delivery, "not-delivered");
});

test("release gate fails closed for every missing prerequisite", async () => {
  const { statePath } = await setup();
  const plane = new TriageControlPlane({ statePath, git: async () => ({ clean: false, head: "abc" }) });
  const gate = await plane.checkReleaseGate("missing", { deploymentRequired: true });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ["authoritative-work-item", "clean-working-tree", "commit-evidence", "validation-evidence", "review-evidence", "release-artifact", "deployment-evidence", "final-work-item-update", "final-post-deployment-commit-evidence"]);
});

test("release gate accepts SHA only in linked commit evidence and safe-to-proceed needs a final post-deployment commit", async () => {
  const { statePath } = await setup();
  let head = "predeploy-sha";
  const plane = new TriageControlPlane({ statePath, git: async () => ({ clean: true, head }) });
  await plane.registerPoc("payments", poc, false);
  const { defect } = await plane.intake({ reporter: "r", source: "s", sourceDomain: "s", ownerDomain: "payments", targetPocSessionId: poc.sessionId, symptom: "x", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [], currentSessionId: poc.sessionId });
  await plane.assignWorkItem(defect.id, { id: "BUG-1", path: "backlog/BUG-1.md", status: "in-progress", lifecycleStates: ["in-progress", "closed"] }, poc.sessionId);
  await plane.recordEvidence(defect.id, { type: "validation", status: "passed", path: "evidence/test.txt" });
  await plane.recordEvidence(defect.id, { type: "review", status: "passed", path: "evidence/review.txt" });
  await plane.recordCommitEvidence(defect.id, { sha: "unphased-sha", phase: "other", path: "evidence/unphased-commit.json" });
  await assert.rejects(() => plane.recordDeploymentEvidence(defect.id, { artifact: "app@1.2.3", receipt: "deploy:42", verification: "healthy" }), /pre-deployment commit evidence/i);
  await plane.recordCommitEvidence(defect.id, { sha: "predeploy-sha", phase: "pre-deployment", path: "evidence/commit.json" });
  await plane.recordDeploymentEvidence(defect.id, { artifact: "app@1.2.3", receipt: "deploy:42", verification: "healthy" });
  let gate = await plane.checkReleaseGate(defect.id, { deploymentRequired: true });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ["final-work-item-update", "final-post-deployment-commit-evidence"]);
  await assert.rejects(() => plane.recordCommitEvidence(defect.id, { sha: "final-sha", phase: "post-deployment", path: "evidence/final-commit.json" }), /final authoritative work-item transition/i);
  await plane.transitionWorkItem(defect.id, "closed", { nextAction: "none" });
  head = "final-sha";
  await assert.rejects(() => plane.recordCommitEvidence(defect.id, { sha: "predeploy-sha", phase: "post-deployment", path: "evidence/not-a-second-commit.json" }), /distinct pre-deployment commit SHA/i);
  gate = await plane.checkReleaseGate(defect.id, { deploymentRequired: true });
  assert.deepEqual(gate.missing, ["final-post-deployment-commit-evidence"]);
  await assert.rejects(() => plane.recordRequesterMessage(defect.id, "safe-to-proceed", "safe", { deploymentRequired: true }), /release gate/i);
  await plane.recordCommitEvidence(defect.id, { sha: "final-sha", phase: "post-deployment", path: "evidence/final-commit.json" });
  gate = await plane.checkReleaseGate(defect.id, { deploymentRequired: true });
  assert.equal(gate.ok, true);
  const message = await plane.recordRequesterMessage(defect.id, "safe-to-proceed", "Safe to proceed", { deploymentRequired: true });
  assert.equal(message.type, "requester-message");
  const current = await plane.getDefect(defect.id);
  assert.equal("sha" in current.workItem, false);
});
