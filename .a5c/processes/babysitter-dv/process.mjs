import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { defineTask } from "@a5c-ai/babysitter-sdk";
import path from "node:path";
import { promisify } from "node:util";
import { createAfkDeliveryBlueprint } from "./src/afk-delivery-blueprint.js";
import { createEvidenceJournal } from "./src/evidence-manifest.js";

const execFileAsync = promisify(execFile);

const defaultImplementationTask = defineTask("babysitter-dv-default-implementation", ({ itemId, prompt, agent }) => ({
  kind: "agent",
  title: "Implement " + itemId,
  description: prompt,
  agent: { name: agent, prompt },
}));
const defaultDeliveryGatesTask = defineTask("babysitter-dv-default-delivery-gates", ({ itemId, prompt, agent }) => ({
  kind: "agent",
  title: "Complete delivery gates for " + itemId,
  description: prompt,
  agent: { name: agent, prompt },
}));

async function readyItemIds(cwd) {
  const { stdout } = await execFileAsync("dv", ["work", "ready", "--json"], { cwd });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result.candidates)) throw new TypeError("dv work ready --json did not return candidates");
  return result.candidates.map((item) => item.id).filter((id) => typeof id === "string" && id.length > 0);
}

function halt(ctx, reason, payload) {
  if (typeof ctx?.halt === "function") return ctx.halt(reason, payload);
  return { halt: true, reason, payload };
}

async function optionalOverridePorts(configModule, runInput) {
  if (!configModule) return null;
  const config = await import(configModule.startsWith("file:") ? configModule : new URL(configModule, "file://").href);
  const resolvePorts = config.createPorts ?? config.default;
  if (typeof resolvePorts !== "function") throw new TypeError("config module must export createPorts(inputs) or default(inputs)");
  return resolvePorts(runInput);
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function worktreeOwnershipPath(worktreeRoot, itemId) {
  return path.join(worktreeRoot, ".babysitter-dv", Buffer.from(itemId).toString("hex") + ".json");
}

function repositoryIdentity(cwd) {
  const root = realpathSync(gitOutput(cwd, ["rev-parse", "--show-toplevel"]));
  const commonDir = realpathSync(path.resolve(root, gitOutput(cwd, ["rev-parse", "--git-common-dir"])));
  return { root, commonDir };
}

function isOwnedDeliveryBranch(itemId, branch) {
  const prefix = "worktree/" + itemId + "-";
  return branch.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch.slice(prefix.length));
}

function persistDeliveryBranch(ownershipPath, ownership, branch) {
  const temporaryPath = ownershipPath + "." + globalThis.process.pid + ".tmp";
  writeFileSync(temporaryPath, JSON.stringify({ ...ownership, deliveryBranch: branch }) + "\n", { mode: 0o600 });
  renameSync(temporaryPath, ownershipPath);
}

function reuseOwnedWorktree({ itemId, worktree, ownershipPath, repository, targetRef }) {
  let ownership;
  try { ownership = JSON.parse(readFileSync(ownershipPath, "utf8")); } catch { throw new Error("refusing to reuse an unowned worktree"); }
  if (
    ownership?.itemId !== itemId || ownership.worktree !== worktree || ownership.repository !== repository.commonDir
    || ownership.targetRef !== targetRef || !/^[0-9a-f]{40}$/i.test(ownership.targetBaseSha)
  ) throw new Error("refusing to reuse a mismatched worktree");
  let worktreeRoot;
  let commonDir;
  try {
    worktreeRoot = realpathSync(gitOutput(worktree, ["rev-parse", "--show-toplevel"]));
    commonDir = realpathSync(path.resolve(worktreeRoot, gitOutput(worktree, ["rev-parse", "--git-common-dir"])));
  } catch { throw new Error("refusing to reuse a non-Git worktree"); }
  if (worktreeRoot !== worktree || commonDir !== repository.commonDir) throw new Error("refusing to reuse a foreign worktree");
  const registration = gitOutput(repository.root, ["worktree", "list", "--porcelain"]).split("\n\n").find((entry) => entry.startsWith("worktree " + worktree + "\n") || entry === "worktree " + worktree);
  if (!registration) throw new Error("refusing to reuse an unregistered worktree");
  try { gitOutput(worktree, ["merge-base", "--is-ancestor", ownership.targetBaseSha, "HEAD"]); } catch { throw new Error("refusing to reuse a worktree at an unexpected ref"); }
  let branch;
  try { branch = gitOutput(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch {}
  if (!branch) return;
  if (!registration.split("\n").includes("branch refs/heads/" + branch)) throw new Error("refusing to reuse an unexpected delivery branch");
  if (ownership.deliveryBranch === branch) return;
  if (ownership.deliveryBranch == null && isOwnedDeliveryBranch(itemId, branch)) return persistDeliveryBranch(ownershipPath, ownership, branch);
  throw new Error("refusing to reuse an unexpected delivery branch");
}

function createDefaultPorts({ ctx, workspace }) {
  return {
    publisherSelection: {
      async select(request) {
        const workItemId = request?.request?.workItemId;
        const command = ["dv", "work", "select", workItemId, "--request", "-", "--json"];
        const stdout = execFileSync(command[0], command.slice(1), {
          cwd: workspace,
          input: JSON.stringify(request),
          encoding: "utf8",
        });
        const response = JSON.parse(stdout);
        const artifact = response?.decisionArtifact;
        if (artifact && !Array.isArray(artifact.command)) {
          return { ...response, decisionArtifact: { command, result: artifact } };
        }
        return response;
      },
    },
    journalFactory: createEvidenceJournal,
    state: { async transition(event) { return event; } },
    worktreeTransaction: {
      withEvidenceGuard() {},
      async prepareItem({ itemId, cwd, targetBranch } = {}) {
        const worktreeRoot = path.join(realpathSync(workspace), ".a5c/worktrees");
        const worktree = path.resolve(worktreeRoot, itemId);
        if (path.dirname(worktree) !== worktreeRoot) throw new Error("work item ID must name one worktree directory");
        const targetRef = targetBranch ?? "HEAD";
        const repository = repositoryIdentity(cwd);
        const ownershipPath = worktreeOwnershipPath(worktreeRoot, itemId);
        if (existsSync(worktree)) {
          reuseOwnedWorktree({ itemId, worktree, ownershipPath, repository, targetRef });
          return { itemId, worktree, targetBranch: targetBranch ?? null };
        }
        if (existsSync(ownershipPath)) throw new Error("refusing to replace a missing owned worktree");
        const targetBaseSha = gitOutput(cwd, ["rev-parse", "--verify", targetRef]);
        mkdirSync(worktreeRoot, { recursive: true });
        execFileSync("git", ["worktree", "add", "--detach", worktree, targetBaseSha], { cwd, stdio: "ignore" });
        mkdirSync(path.dirname(ownershipPath), { recursive: true });
        writeFileSync(ownershipPath, JSON.stringify({ itemId, worktree, repository: repository.commonDir, targetRef, targetBaseSha, deliveryBranch: null }) + "\n", { mode: 0o600 });
        return { itemId, worktree, targetBranch: targetBranch ?? null };
      },
    },
    delivery: {
      async review({ item, implementer } = {}) {
        const itemId = item?.itemId;
        if (typeof ctx?.task !== "function") return { status: "paused", reason: "Babysitter task context unavailable for default implementation adapter", itemId };
        const implementationPrompt = "Resolve DV work item " + itemId + " in dedicated worktree " + item.worktree + " for workspace " + workspace + ". Implement the requested change and run focused validation. Return status \"delivered\" only if independent review, DV closure, commit evidence, and integration are also complete; otherwise return status \"paused\" with exactly what remains.";
        const result = await ctx.task(defaultImplementationTask, { itemId, workspace, worktree: item.worktree, prompt: implementationPrompt, agent: implementer ?? "babysitter-dv-implementer" });
        const gatePrompt = "Continue DV work item " + itemId + " from existing worktree " + item.worktree + ". Complete the remaining delivery gates only: independent review by someone other than the implementer, required remediation if review requests changes, commit/closure evidence, DV closure, and integration into the target branch. Return status \"delivered\" only after all gates are complete; otherwise return status \"paused\" with recovery notes.";
        const gated = await ctx.task(defaultDeliveryGatesTask, { itemId, workspace, worktree: item.worktree, previous: result, prompt: gatePrompt, agent: "babysitter-dv-reviewer" });
        return gated && typeof gated.status === "string" ? gated : { status: "paused", reason: "delivery gate task did not return a delivery outcome", result: gated };
      },
    },
  };
}

async function runItem({ configModule, runInput, ctx, workspace }) {
  const ports = await optionalOverridePorts(configModule, runInput) ?? createDefaultPorts({ ctx, workspace });
  return createAfkDeliveryBlueprint(ports).run(runInput);
}

/** Project-local Babysitter-DV process. With no itemId, drains ready DV work until empty or halted. */
export async function process(inputs = {}, ctx) {
  if (!inputs || typeof inputs !== "object") throw new TypeError("Babysitter-DV inputs must be an object");
  const workspace = path.resolve(inputs.workspace ?? inputs.runInput?.cwd ?? globalThis.process.cwd());
  const configModule = inputs.configModule ? path.resolve(inputs.configModule) : null;
  if (configModule && !configModule.endsWith(".mjs")) throw new TypeError("configModule must be a local .mjs module");

  if (typeof inputs.runInput?.itemId === "string" && inputs.runInput.itemId.length > 0) {
    const runInput = { ...inputs.runInput, cwd: inputs.runInput.cwd ?? workspace, runDirectory: inputs.runInput.runDirectory ?? path.join(workspace, ".a5c/runs", inputs.runInput.itemId) };
    const outcome = await runItem({ configModule, runInput, ctx, workspace });
    return outcome?.status === "delivered" ? outcome : halt(ctx, "babysitter-dv-paused", { itemId: runInput.itemId, outcome });
  }

  const completed = [];
  const attempted = new Set();
  while (true) {
    const ready = await readyItemIds(workspace);
    if (ready.length === 0) return { status: "drained", completed };
    const itemId = ready.find((id) => !attempted.has(id));
    if (!itemId) return halt(ctx, "babysitter-dv-stalled", { reason: "ready candidates did not change after attempted delivery", ready, completed });
    attempted.add(itemId);
    const runInput = { ...(inputs.runInput ?? {}), itemId, cwd: workspace, runDirectory: path.join(workspace, ".a5c/runs", itemId) };
    const outcome = await runItem({ configModule, runInput, ctx, workspace });
    completed.push({ itemId, outcome });
    if (outcome?.status !== "delivered") return halt(ctx, "babysitter-dv-paused", { itemId, outcome, completed });
  }
}
