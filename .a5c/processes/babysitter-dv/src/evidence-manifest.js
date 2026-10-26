import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const EVIDENCE_SCHEMA_VERSION = "babysitter-evidence/v1";
export const REQUIRED_EVIDENCE_CATEGORIES = Object.freeze(["input", "command", "dv", "review", "diff", "commit", "integration", "hash"]);
export const GUARDED_TRANSITIONS = Object.freeze(["dv-ready", "dv-show", "dv-validate", "prepare-item", "state-transition", "review-request", "remediate", "affected-acceptance", "dv-close", "closure-commit", "integration-deliver", "integration-refresh", "integration-retry", "cas-publication", "cleanup"]);
const CATEGORIES = new Set(REQUIRED_EVIDENCE_CATEGORIES);
const TRANSITIONS = new Set(GUARDED_TRANSITIONS);
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(message) { throw new TypeError(`Invalid evidence manifest: ${message}`); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeRelativePath(value) {
  return typeof value === "string" && value !== "" && !path.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function regularFile(file, label) {
  let stat;
  try { stat = await lstat(file); } catch { invalid(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(`${label} must be a regular non-symlink file`);
}
async function containedFile(root, file, label) {
  await regularFile(file, label);
  const resolved = await realpath(file);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) invalid(`${label} escapes run directory`);
  return resolved;
}

/** Strictly verify a manifest rooted under its run directory and linked to an action. */
export async function verifyEvidenceManifest({ runDirectory, manifestPath, expectedTransition } = {}) {
  if (typeof runDirectory !== "string" || runDirectory === "") invalid("run directory is required");
  let root;
  try { root = await realpath(runDirectory); } catch { invalid("run directory is unreadable"); }
  const expectedManifest = path.join(root, "manifest.json");
  const requestedManifest = path.resolve(manifestPath ?? expectedManifest);
  if (requestedManifest !== expectedManifest) invalid("manifest must be the run-directory manifest");
  await containedFile(root, requestedManifest, "manifest");
  let manifest;
  try { manifest = JSON.parse(await readFile(requestedManifest, "utf8")); } catch { invalid("manifest is malformed"); }
  if (!isObject(manifest) || manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION || !Array.isArray(manifest.artifacts)) invalid("schema version or artifacts is invalid");
  if (Object.keys(manifest).some((key) => !["schemaVersion", "artifacts"].includes(key))) invalid("unexpected manifest field");
  const categories = new Set(); const artifactPaths = new Set(); let linked = expectedTransition === undefined;
  for (const artifact of manifest.artifacts) {
    if (!isObject(artifact) || Object.keys(artifact).some((key) => !["path", "category", "sha256", "transition"].includes(key))) invalid("artifact schema is invalid");
    if (!safeRelativePath(artifact.path)) invalid("artifact path is unsafe");
    if (!CATEGORIES.has(artifact.category)) invalid("artifact category is invalid");
    if (artifactPaths.has(artifact.path)) invalid("artifact path is duplicated");
    if (typeof artifact.transition !== "string" || !TRANSITIONS.has(artifact.transition)) invalid("artifact transition is invalid");
    if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) invalid("artifact hash is malformed");
    const target = path.resolve(root, artifact.path);
    await containedFile(root, target, `artifact ${artifact.path}`);
    if (hash(await readFile(target)) !== artifact.sha256) invalid(`artifact hash mismatch: ${artifact.path}`);
    categories.add(artifact.category); artifactPaths.add(artifact.path);
    if (artifact.transition === expectedTransition) linked = true;
  }
  if (REQUIRED_EVIDENCE_CATEGORIES.some((category) => !categories.has(category))) invalid("required categories are incomplete");
  if (!linked) invalid(`manifest lacks evidence linked to transition ${expectedTransition}`);
  return Object.freeze({ schemaVersion: manifest.schemaVersion, artifacts: manifest.artifacts.map((artifact) => Object.freeze({ ...artifact })) });
}

/** Append-only filesystem journal that writes typed artifacts and atomically refreshes its manifest. */
export async function createEvidenceJournal({ runDirectory, input = {} } = {}) {
  if (typeof runDirectory !== "string" || runDirectory === "") throw new TypeError("run directory is required");
  await mkdir(runDirectory, { recursive: true });
  const root = await realpath(runDirectory);
  const artifactDirectory = path.join(root, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const journalPath = path.join(root, "journal.ndjson");
  let artifacts = [];
  let sequence = 0;
  let journalExists = true;
  try { await lstat(journalPath); } catch (error) {
    if (error?.code === "ENOENT") journalExists = false;
    else throw error;
  }
  if (journalExists) {
    await regularFile(journalPath, "journal");
    const manifest = await verifyEvidenceManifest({ runDirectory: root });
    const bootstrap = manifest.artifacts[0];
    if (!bootstrap || bootstrap.path !== "artifacts/0001-input.json" || bootstrap.category !== "input") invalid("bootstrap input artifact is invalid");
    let record;
    try { record = JSON.parse(await readFile(path.join(root, bootstrap.path), "utf8")); } catch { invalid("bootstrap input artifact is malformed"); }
    if (!isObject(record) || record.sequence !== 1 || record.category !== "input" || record.transition !== "prepare-item" || record.type !== "run-initialized" || !("input" in record) || JSON.stringify(record.input) !== JSON.stringify(input)) invalid("run input does not match existing journal");
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (artifact.path !== `artifacts/${String(index + 1).padStart(4, "0")}-${artifact.category}.json`) invalid("artifact sequence is invalid");
    }
    artifacts = [...manifest.artifacts];
    sequence = artifacts.length;
  }
  async function append(event) {
    if (!isObject(event) || !CATEGORIES.has(event.category) || !TRANSITIONS.has(event.transition)) throw new TypeError("journal event requires a known category and guarded transition");
    const record = Object.freeze({ sequence: sequence += 1, at: new Date().toISOString(), ...event });
    const relative = `artifacts/${String(record.sequence).padStart(4, "0")}-${record.category}.json`;
    const bytes = `${JSON.stringify(record)}\n`;
    await writeFile(path.join(root, relative), bytes, { flag: "wx" });
    await appendFile(journalPath, bytes, { flag: "a" });
    artifacts.push({ path: relative, category: record.category, sha256: hash(bytes), transition: record.transition });
    const manifest = JSON.stringify({ schemaVersion: EVIDENCE_SCHEMA_VERSION, artifacts });
    const temporary = path.join(root, ".manifest.json.tmp");
    await writeFile(temporary, manifest, { flag: "w" });
    await rename(temporary, path.join(root, "manifest.json"));
    return record;
  }
  // Bootstrap retains a complete typed set; later action records establish the specific linkage.
  if (artifacts.length === 0) for (const category of REQUIRED_EVIDENCE_CATEGORIES) await append({ category, transition: "prepare-item", type: "run-initialized", input: category === "input" ? input : undefined });
  return Object.freeze({ append, runDirectory: root, journalPath, artifacts: () => [...artifacts] });
}
