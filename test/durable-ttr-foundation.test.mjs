import assert from "node:assert/strict";
import { access, constants, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  importCanonicalSnapshot,
  inspectCanonicalState,
  openTtrFoundation,
} from "../durable-ttr/index.ts";

const snapshot = {
  source: { version: 2, capturedAt: "2026-03-12T00:00:00.000Z" },
  domains: [{ id: "payments", managerSessionId: "payments-manager" }],
  defects: [{
    id: "ttr-1",
    report: { reporter: "customer", source: "support:1", sourceDomain: "storefront", symptom: "declined", impact: "checkout", environment: "prod", reproduction: "submit card", evidenceReferences: ["ticket:1"] },
    coordinatorDomain: "payments",
    workItems: [{ domain: "payments", id: "wi-00021", path: "backlog/00021.md", status: "ready", lifecycleStates: ["ready", "done"] }],
    evidence: [{ type: "validation", status: "passed", path: "test/durable-ttr-foundation.test.mjs" }],
  }],
};

async function databasePath() {
  return join(await mkdtemp(join(tmpdir(), "durable-ttr-")), "foundation.sqlite");
}

test("read-only inspection does not initialize a missing foundation database", async () => {
  const database = await databasePath();

  await assert.rejects(() => inspectCanonicalState(database), /does not exist/i);
  await assert.rejects(() => access(database, constants.F_OK), { code: "ENOENT" });
});

test("core document API imports a canonical snapshot once and exposes its immutable receipt", async () => {
  const database = await databasePath();

  await assert.rejects(
    () => importCanonicalSnapshot(database, { ...snapshot, domains: [...snapshot.domains, snapshot.domains[0]] }),
    /duplicate domain/i,
  );
  const first = await importCanonicalSnapshot(database, snapshot);
  const second = await importCanonicalSnapshot(database, snapshot);
  const state = await inspectCanonicalState(database);

  assert.equal(first.imported, true);
  assert.equal(second.imported, false);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(state.defects[0].id, "ttr-1");
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].sourceHash, first.receipt.sourceHash);
});

test("service boundary resumes only a replay-safe maintenance task after reopen", async () => {
  const database = await databasePath();
  await importCanonicalSnapshot(database, snapshot);
  const started = Promise.withResolvers();
  const service = await openTtrFoundation(database, {
    runSafeTask: async (_task, signal) => {
      started.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    },
  });
  const before = await service.status();

  await assert.rejects(() => service.intake({}), /not available/i);
  await assert.rejects(() => service.route({}), /not available/i);
  await assert.rejects(() => service.externalEffect({}), /not available/i);
  await assert.rejects(() => service.runTask({ replay: "unsafe" }), /replay-safe/i);
  const pending = service.runTask({ replay: "safe", id: "rebuild-status" });
  await started.promise;
  await service.close();
  await pending.catch(() => {});

  const resumed = Promise.withResolvers();
  const reopened = await openTtrFoundation(database, { runSafeTask: async task => resumed.resolve(task.id) });
  assert.equal(await resumed.promise, "rebuild-status");
  const after = await reopened.status();
  await reopened.close();

  assert.deepEqual(after, before);
});
