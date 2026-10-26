function text(result) {
  return typeof result === "string" ? result.trim() : String(result ?? "").trim();
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function validSha(value) {
  return /^[0-9a-f]{4,}$/i.test(value);
}

/**
 * Stack-neutral isolated-worktree delivery transaction.
 *
 * `git` receives `{ args, cwd }`; callers supply their own process adapter.
 * `journal`, `paths`, and `acceptance` are injected so this module has no Node
 * process, filesystem, or acceptance-stack dependency.
 */
export function createGitWorktreeTransaction({ git, journal, paths, acceptance, review, guard }) {
  if (typeof git !== "function") throw new TypeError("git runner must be a function");
  if (!journal || typeof journal.append !== "function") throw new TypeError("journal sink must append evidence");
  if (!paths || typeof paths.item !== "function" || typeof paths.integration !== "function") throw new TypeError("worktree paths must be provided");
  if (!acceptance || typeof acceptance.run !== "function") throw new TypeError("acceptance adapter must run checks");
  if (!review || typeof review.verify !== "function") throw new TypeError("review verifier must validate evidence");
  if (!guard || typeof guard.before !== "function") throw new TypeError("transaction evidence guard must verify actions");

  let activeJournal = journal;
  let activeGuard = guard;
  const run = async (args, cwd) => text(await git({ args, cwd }));
  const record = async (event) => activeJournal.append(event);
  const guardBefore = async (event) => {
    await record({ type: "delivery-action-intent", ...event });
    await activeGuard.before(event);
  };
  function withEvidenceGuard({ before, journal: evidenceJournal } = {}) {
    if (typeof before !== "function" || !evidenceJournal || typeof evidenceJournal.append !== "function") throw new TypeError("evidence guard and journal are required");
    activeGuard = { before };
    activeJournal = evidenceJournal;
    return api;
  };

  async function resolveTarget({ cwd, targetBranch }) {
    requireString(cwd, "invocation cwd");
    const repositoryRoot = await run(["rev-parse", "--show-toplevel"], cwd);
    if (!repositoryRoot) throw new Error("Invocation PWD is outside a Git worktree");
    let branch = targetBranch;
    if (branch === undefined) {
      try { branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd); } catch {
        throw new Error("Target branch is ambiguous: invocation PWD has detached HEAD");
      }
    }
    requireString(branch, "target branch");
    await run(["check-ref-format", "--branch", branch], repositoryRoot);
    let baseSha;
    try { baseSha = await run(["rev-parse", "--verify", `refs/heads/${branch}`], repositoryRoot); } catch {
      throw new Error(`Unknown target branch: ${branch}`);
    }
    if (!validSha(baseSha)) throw new Error(`Unknown target branch: ${branch}`);
    return { repositoryRoot, targetBranch: branch, targetBaseSha: baseSha };
  }

  async function prepareItem({ itemId, cwd, targetBranch } = {}) {
    await guardBefore({ action: "prepare-item", category: "integration", itemId, targetBranch });
    requireString(itemId, "item ID");
    const target = await resolveTarget({ cwd, targetBranch });
    const location = await paths.item({ itemId, ...target });
    if (!location || typeof location !== "object") throw new TypeError("item worktree path must be provided");
    const branch = requireString(location.branch, "item branch");
    const worktree = requireString(location.worktree, "item worktree");
    await run(["worktree", "add", "-b", branch, worktree, target.targetBaseSha], target.repositoryRoot);
    const item = { itemId, ...target, branch, worktree };
    try {
      await record({ type: "item-worktree-created", itemId, targetBranch: target.targetBranch, targetBaseSha: target.targetBaseSha, branch, worktree });
    } catch (recordError) {
      recordError.postEffectRecord = true;
      recordError.effect = { category: "integration", action: "item-worktree-create", itemId, targetBranch: target.targetBranch, targetBaseSha: target.targetBaseSha, branch, worktree };
      throw recordError;
    }
    return item;
  }

  function assertItem(item) {
    if (!item || typeof item !== "object") throw new TypeError("item worktree evidence is required");
    for (const key of ["itemId", "repositoryRoot", "targetBranch", "targetBaseSha", "branch", "worktree"]) requireString(item[key], `item.${key}`);
    if (!validSha(item.targetBaseSha)) throw new TypeError("item.targetBaseSha must be a Git SHA");
  }

  function assertStrategy(strategy) {
    if (!["merge-commit", "squash", "rebase"].includes(strategy)) throw new TypeError("unknown integration strategy");
  }

  async function actionOutcome(event, result, error) {
    try {
      await record({ type: "delivery-action-outcome", ...event, result, ...(error ? { error: error.message } : {}) });
    } catch (recordError) {
      // The side effect already completed; callers must not recast this as an
      // operation failure or retry a destructive/non-idempotent operation.
      recordError.postEffectRecord = true;
      recordError.effect = event;
      throw recordError;
    }
  }

  async function cleanup(item, integrationWorktree) {
    const shared = { category: "integration", itemId: item.itemId, itemWorktree: item.worktree, integrationWorktree, branch: item.branch };
    const effects = [
      { action: "integration-worktree-remove", args: ["worktree", "remove", "--force", integrationWorktree] },
      { action: "item-worktree-remove", args: ["worktree", "remove", "--force", item.worktree] },
      { action: "branch-delete", args: ["branch", "-D", item.branch] },
    ];
    for (const effect of effects) {
      const event = { ...shared, action: effect.action, transition: "cleanup" };
      // An individual intent/outcome pair permits deterministic recovery after
      // a crash or partial destructive cleanup.
      await record({ type: "delivery-cleanup-intent", ...event });
      try {
        await guardBefore(event);
        await run(effect.args, item.repositoryRoot);
      } catch (error) {
        await record({ type: "delivery-cleanup-outcome", ...event, result: "failed", error: error.message });
        throw error;
      }
      try {
        await record({ type: "delivery-cleanup-outcome", ...event, result: "succeeded" });
      } catch (recordError) {
        recordError.postEffectRecord = true;
        recordError.effect = event;
        throw recordError;
      }
    }
  }

  function failure(item, worktree, strategy, phase, error) {
    return { type: "delivery-failed", itemId: item.itemId, targetBranch: item.targetBranch, targetBaseSha: item.targetBaseSha, itemWorktree: item.worktree, integrationWorktree: worktree, strategy, phase, ...(error ? { error: error.message } : {}) };
  }

  function uncertainEffect(item, worktree, strategy, error) {
    return { status: "integration-effect-recording-uncertain", itemWorktree: item.worktree, integrationWorktree: worktree, recovery: { sideEffectMayHaveSucceeded: true, effect: error.effect, item, strategy, recordError: error.message, required: ["inspect-effect-state", "repair-evidence", "do-not-retry-effect"] } };
  }

  async function createCandidate(item, strategy, worktree) {
    let activeEffect;
    try {
      const start = strategy === "rebase" ? item.branch : item.targetBaseSha;
      const create = { category: "integration", action: "integration-worktree-create", itemId: item.itemId, strategy, worktree, start };
      activeEffect = create;
      await record({ type: "delivery-integration-worktree-intent", ...create });
      await run(["worktree", "add", "--detach", worktree, start], item.repositoryRoot);
      await actionOutcome(create, "succeeded");
    } catch (error) {
      if (error?.postEffectRecord === true) return uncertainEffect(item, worktree, strategy, error);
      if (activeEffect) await actionOutcome(activeEffect, "failed", error);
      await record(failure(item, worktree, strategy, "provisioning", error));
      return { status: "failed", itemWorktree: item.worktree, integrationWorktree: worktree };
    }
    try {
      activeEffect = undefined;
      if (strategy === "merge-commit") {
        const merge = { category: "integration", action: "merge", itemId: item.itemId, strategy, worktree, branch: item.branch };
        activeEffect = merge;
        await record({ type: "delivery-integration-strategy-intent", ...merge });
        await run(["merge", "--no-ff", "--no-edit", item.branch], worktree);
        await actionOutcome(merge, "succeeded");
      } else if (strategy === "squash") {
        const squash = { category: "integration", action: "squash", itemId: item.itemId, strategy, worktree, branch: item.branch };
        activeEffect = squash;
        await record({ type: "delivery-integration-strategy-intent", ...squash });
        await run(["merge", "--squash", item.branch], worktree);
        await actionOutcome(squash, "succeeded");
        const commit = { category: "commit", action: "squash-commit", itemId: item.itemId, strategy, worktree };
        activeEffect = commit;
        await record({ type: "delivery-integration-commit-intent", ...commit });
        await run(["commit", "--no-edit", "-m", `Integrate ${item.itemId}`], worktree);
        await actionOutcome(commit, "succeeded");
      } else {
        const rebase = { category: "integration", action: "rebase", itemId: item.itemId, strategy, worktree, targetBranch: item.targetBranch };
        activeEffect = rebase;
        await record({ type: "delivery-integration-strategy-intent", ...rebase });
        await run(["rebase", item.targetBranch], worktree);
        await actionOutcome(rebase, "succeeded");
      }
    } catch (error) {
      if (error?.postEffectRecord === true) return uncertainEffect(item, worktree, strategy, error);
      if (activeEffect) await actionOutcome(activeEffect, "failed", error);
      const unmergedPaths = await run(["diff", "--name-only", "--diff-filter=U"], worktree).catch(() => "");
      if (unmergedPaths) {
        await record({ type: "delivery-conflict", itemId: item.itemId, targetBranch: item.targetBranch, targetBaseSha: item.targetBaseSha, itemWorktree: item.worktree, integrationWorktree: worktree, strategy, phase: "integration", error: error.message });
        return { status: "conflict", itemWorktree: item.worktree, integrationWorktree: worktree };
      }
      await record(failure(item, worktree, strategy, "integration", error));
      return { status: "failed", itemWorktree: item.worktree, integrationWorktree: worktree };
    }
    let checksPassed;
    try {
      const rootAcceptance = { category: "command", action: "root-acceptance", itemId: item.itemId, strategy, worktree };
      activeEffect = rootAcceptance;
      await record({ type: "delivery-root-acceptance-intent", ...rootAcceptance });
      checksPassed = await acceptance.run({ candidate: "integration", repositoryRoot: item.repositoryRoot, worktree, item, strategy });
      await actionOutcome(rootAcceptance, checksPassed ? "succeeded" : "failed");
    } catch (error) {
      if (error?.postEffectRecord === true) return uncertainEffect(item, worktree, strategy, error);
      if (activeEffect) await actionOutcome(activeEffect, "failed", error);
      await record(failure(item, worktree, strategy, "acceptance", error));
      return { status: "failed", itemWorktree: item.worktree, integrationWorktree: worktree };
    }
    if (!checksPassed) {
      await record(failure(item, worktree, strategy, "acceptance"));
      return { status: "failed", itemWorktree: item.worktree, integrationWorktree: worktree };
    }
    const candidateEffect = { category: "integration", action: "candidate-sha", itemId: item.itemId, strategy, worktree };
    try {
      await record({ type: "delivery-candidate-sha-intent", ...candidateEffect });
      const candidateSha = await run(["rev-parse", "HEAD"], worktree);
      if (!validSha(candidateSha)) throw new Error("integration candidate did not produce a Git SHA");
      await actionOutcome({ ...candidateEffect, candidateSha }, "succeeded");
      return { status: "candidate", candidateSha, worktree };
    } catch (error) {
      if (error?.postEffectRecord === true) return uncertainEffect(item, worktree, strategy, error);
      await actionOutcome(candidateEffect, "failed", error);
      return { status: "failed", itemWorktree: item.worktree, integrationWorktree: worktree };
    }
  }

  function staleResult(item, worktree, strategy, candidateSha) {
    return {
      status: "stale",
      itemWorktree: item.worktree,
      integrationWorktree: worktree,
      candidateSha,
      recovery: {
        action: "refreshStale",
        required: ["refresh-at-current-target", "root-acceptance", "independent-review", "explicit-retry"],
        item,
        strategy,
        attempt: 0,
      },
    };
  }

  function publicationIntent(item, worktree, strategy, candidateSha) {
    return {
      type: "delivery-publication-intent",
      itemId: item.itemId,
      repositoryRoot: item.repositoryRoot,
      targetBranch: item.targetBranch,
      expectedBaseSha: item.targetBaseSha,
      candidateSha,
      itemWorktree: item.worktree,
      integrationWorktree: worktree,
      strategy,
    };
  }

  function publicationFailure(item, worktree, strategy, candidateSha, intent, error) {
    return {
      status: "publication-failed",
      itemWorktree: item.worktree,
      integrationWorktree: worktree,
      candidateSha,
      recovery: {
        action: "retryPublication",
        required: ["inspect-publication-state", "explicit-retry"],
        item,
        strategy,
        publicationIntent: intent,
        ...(error ? { error: error.message } : {}),
      },
    };
  }

  async function publish(item, worktree, strategy, candidateSha) {
    const intent = publicationIntent(item, worktree, strategy, candidateSha);
    try {
      await record(intent);
    } catch (error) {
      return publicationFailure(item, worktree, strategy, candidateSha, intent, error);
    }

    try {
      const cas = { action: "cas-publication", category: "integration", itemId: item.itemId, targetBranch: item.targetBranch, expectedBaseSha: item.targetBaseSha, candidateSha, itemWorktree: item.worktree, integrationWorktree: worktree };
      await guardBefore(cas);
      await run(["update-ref", `refs/heads/${item.targetBranch}`, candidateSha, item.targetBaseSha], item.repositoryRoot);
      await actionOutcome(cas, "succeeded");
    } catch (error) {
      if (error?.postEffectRecord === true) {
        return {
          status: "published-but-cas-recording-uncertain", targetBranch: item.targetBranch, publishedSha: candidateSha,
          recovery: { sideEffectMayHaveSucceeded: true, action: "cas-publication", effect: error.effect, itemWorktree: item.worktree, integrationWorktree: worktree, recordError: error.message, required: ["inspect-target-ref", "repair-evidence", "do-not-retry-cas"] },
        };
      }
      await actionOutcome({ action: "cas-publication", category: "integration", itemId: item.itemId, targetBranch: item.targetBranch, expectedBaseSha: item.targetBaseSha, candidateSha, itemWorktree: item.worktree, integrationWorktree: worktree }, "failed", error).catch(() => {});
      let currentTargetSha;
      try {
        currentTargetSha = await run(["rev-parse", "--verify", `refs/heads/${item.targetBranch}`], item.repositoryRoot);
      } catch (readError) {
        return publicationFailure(item, worktree, strategy, candidateSha, intent, readError);
      }
      if (currentTargetSha !== item.targetBaseSha) {
        await record({ ...intent, type: "delivery-stale", targetBaseSha: item.targetBaseSha, currentTargetSha, error: error.message });
        return staleResult(item, worktree, strategy, candidateSha);
      }
      const failed = { ...intent, type: "delivery-publication-failed", error: error.message };
      try {
        await record(failed);
      } catch (recordError) {
        return publicationFailure(item, worktree, strategy, candidateSha, intent, recordError);
      }
      return publicationFailure(item, worktree, strategy, candidateSha, intent, error);
    }

    const published = { type: "delivery-published", itemId: item.itemId, targetBranch: item.targetBranch, expectedBaseSha: item.targetBaseSha, publishedSha: candidateSha, strategy };
    try {
      await record(published);
    } catch (error) {
      return {
        status: "published-but-recording-failed",
        targetBranch: item.targetBranch,
        publishedSha: candidateSha,
        recovery: {
          targetAlreadyPublished: true,
          cleanupRequired: true,
          itemWorktree: item.worktree,
          integrationWorktree: worktree,
          publicationIntent: intent,
          publicationJournalError: error.message,
        },
      };
    }
    try {
      await cleanup(item, worktree);
    } catch (error) {
      if (error?.postEffectRecord === true) {
        return {
          status: "published-but-cleanup-recording-uncertain", targetBranch: item.targetBranch, publishedSha: candidateSha,
          recovery: { targetAlreadyPublished: true, cleanupRequired: true, sideEffectMayHaveSucceeded: true, action: "cleanup", effect: error.effect, itemWorktree: item.worktree, integrationWorktree: worktree, recordError: error.message, required: ["inspect-cleanup-state", "repair-evidence", "do-not-retry-effect"] },
        };
      }
      const recovery = {
        targetAlreadyPublished: true,
        cleanupRequired: true,
        itemWorktree: item.worktree,
        integrationWorktree: worktree,
        cleanupError: error.message,
      };
      try {
        await record({ ...published, type: "delivery-published-but-cleanup-failed", recovery });
      } catch (recoveryJournalError) {
        recovery.recoveryJournalError = recoveryJournalError.message;
      }
      return { status: "published-but-cleanup-failed", targetBranch: item.targetBranch, publishedSha: candidateSha, recovery };
    }
    return { status: "delivered", targetBranch: item.targetBranch, publishedSha: candidateSha };
  }

  async function deliver({ item, strategy = "merge-commit" } = {}) {
    await guardBefore({ action: "integration-deliver", category: "integration", itemId: item?.itemId, strategy });
    assertItem(item);
    assertStrategy(strategy);
    const location = await paths.integration({ itemId: item.itemId, item, strategy, attempt: 0 });
    const worktree = requireString(location?.worktree, "integration worktree");
    const candidate = await createCandidate(item, strategy, worktree);
    if (candidate.status !== "candidate") return candidate;
    return publish(item, worktree, strategy, candidate.candidateSha);
  }

  async function refreshStale({ stale } = {}) {
    await guardBefore({ action: "integration-refresh", category: "integration", itemId: stale?.recovery?.item?.itemId });
    if (!stale || stale.status !== "stale" || !stale.recovery) throw new TypeError("stale recovery evidence is required");
    const { item: priorItem, strategy, attempt } = stale.recovery;
    assertItem(priorItem);
    assertStrategy(strategy);
    const targetBaseSha = await run(["rev-parse", "--verify", `refs/heads/${priorItem.targetBranch}`], priorItem.repositoryRoot);
    if (!validSha(targetBaseSha)) throw new Error(`Unknown target branch: ${priorItem.targetBranch}`);
    const item = { ...priorItem, targetBaseSha };
    const nextAttempt = attempt + 1;
    const location = await paths.integration({ itemId: item.itemId, item, strategy, attempt: nextAttempt });
    const worktree = requireString(location?.worktree, "integration worktree");
    const candidate = await createCandidate(item, strategy, worktree);
    if (candidate.status !== "candidate") return candidate;
    return {
      status: "refreshed",
      item,
      candidateSha: candidate.candidateSha,
      integrationWorktree: worktree,
      recovery: { action: "retryStale", required: ["fresh-independent-review", "explicit-retry"], strategy, attempt: nextAttempt },
    };
  }

  async function retryStale({ refreshed, independentReview } = {}) {
    await guardBefore({ action: "integration-retry", category: "integration", itemId: refreshed?.item?.itemId });
    if (!refreshed || refreshed.status !== "refreshed") throw new TypeError("refreshed stale evidence is required");
    const reviewer = independentReview?.reviewer;
    const implementer = independentReview?.implementer;
    if (
      !independentReview || independentReview.approved !== true || independentReview.fresh !== true
      || independentReview.candidateSha !== refreshed.candidateSha
      || typeof reviewer?.identity !== "string" || typeof reviewer?.context !== "string"
      || typeof implementer?.identity !== "string" || typeof implementer?.context !== "string"
      || reviewer.identity === implementer.identity || reviewer.context === implementer.context
    ) {
      throw new TypeError("fresh independent review approval for this candidate is required");
    }
    const verified = await review.verify({
      evidence: independentReview,
      candidate: {
        candidateSha: refreshed.candidateSha,
        targetBranch: refreshed.item.targetBranch,
        targetBaseSha: refreshed.item.targetBaseSha,
        itemWorktree: refreshed.item.worktree,
        integrationWorktree: refreshed.integrationWorktree,
        strategy: refreshed.recovery.strategy,
        attempt: refreshed.recovery.attempt,
      },
    });
    if (verified !== true) throw new TypeError("fresh independent review approval for this candidate is required");
    return publish(refreshed.item, refreshed.integrationWorktree, refreshed.recovery.strategy, refreshed.candidateSha);
  }

  const api = Object.freeze({ prepareItem, deliver, refreshStale, retryStale, withEvidenceGuard });
  return api;
}
