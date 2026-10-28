import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hashPilotManifest,
  inspectTtrPilot,
  openTtrPilot,
  selectShadowRoute,
  validatePilotManifest,
} from "../ttr-pilot/index.ts";

const manifest = {
  domain: "ttr-pilot",
  version: 1,
  repositoryBoundary: "calan-co/pi-extensions",
  routing: [
    { id: "support", sourceDomains: ["support"] },
    { id: "default", sourceDomains: ["*"] },
  ],
  outboxAdapter: "noop-shadow-receipt",
};
const report = { id: "report-1", repository: "calan-co/pi-extensions", sourceDomain: "support", summary: "fixture" };

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "ttr-pilot-"));
  return { databasePath: join(dir, "pilot.sqlite"), legacyStatePath: join(dir, "state.json") };
}

test("core pilot API validates a versioned manifest, hashes it canonically, and selects one shadow route", () => {
  const hash = hashPilotManifest(manifest);

  assert.equal(validatePilotManifest(manifest), hash);
  assert.equal(hashPilotManifest({ ...manifest, routing: [...manifest.routing] }), hash);
  assert.deepEqual(selectShadowRoute(manifest, report), { id: "support" });
  assert.throws(() => validatePilotManifest({ ...manifest, domain: "other" }), /ttr-pilot/i);
  assert.throws(() => selectShadowRoute(manifest, { ...report, repository: "other/repo" }), /boundary/i);
});

test("service persists idempotent shadow decisions and noop receipts across reopen without touching legacy state", async () => {
  const { databasePath, legacyStatePath } = await paths();
  await writeFile(legacyStatePath, '{"legacy":true}\n');
  const before = await readFile(legacyStatePath);
  const manifestHash = hashPilotManifest(manifest);
  const service = await openTtrPilot({ databasePath, manifest, manifestHash });

  const first = await service.submitShadowReport({ report, manifestHash, manifestVersion: 1, mode: "shadow" });
  const replay = await service.submitShadowReport({ report, manifestHash, manifestVersion: 1, mode: "shadow" });
  const during = await service.inspect();
  await service.close();

  const reopened = await openTtrPilot({ databasePath, manifest, manifestHash });
  const after = await reopened.inspect();
  const reopenedReplay = await reopened.submitShadowReport({ report, manifestHash, manifestVersion: 1, mode: "shadow" });
  const afterReplay = await reopened.inspect();
  await reopened.close();

  assert.deepEqual(replay, first);
  assert.deepEqual(reopenedReplay, first);
  assert.equal(first.routeId, "support");
  assert.equal(first.outbox.adapter, "noop-shadow-receipt");
  assert.equal(during.decisions.length, 1);
  assert.equal(during.outbox.length, 1);
  assert.deepEqual(after, during);
  assert.deepEqual(afterReplay, during);
  assert.deepEqual(await inspectTtrPilot(databasePath), afterReplay);
  assert.deepEqual(await readFile(legacyStatePath), before);
});

test("service rejects cross-boundary, stale hashes, and non-shadow modes before persistence", async () => {
  const { databasePath } = await paths();
  const manifestHash = hashPilotManifest(manifest);
  const service = await openTtrPilot({ databasePath, manifest, manifestHash });

  await assert.rejects(
    () => service.submitShadowReport({ report: { ...report, repository: "other/repo" }, manifestHash, manifestVersion: 1, mode: "shadow" }),
    /boundary/i,
  );
  await assert.rejects(
    () => service.submitShadowReport({ report, manifestHash: "0".repeat(64), manifestVersion: 1, mode: "shadow" }),
    /manifest hash/i,
  );
  await assert.rejects(
    () => service.submitShadowReport({ report, manifestHash, manifestVersion: 1, mode: "live" }),
    /shadow/i,
  );
  assert.deepEqual(await service.inspect(), { decisions: [], outbox: [] });
  await service.close();
});
