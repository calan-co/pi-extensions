export const PUBLISHER_WORK_SELECTION_CAPABILITY = "publisher-work-selection/v1";

function invalid(message) {
  throw new TypeError(`Invalid publisher work selection: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function jsonSnapshot(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid(`${label} must be JSON-serializable`);
    return value;
  }
  if (!value || typeof value !== "object") invalid(`${label} must be JSON-serializable`);
  if (ancestors.has(value)) invalid(`${label} must be JSON-serializable`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) invalid(`${label} must be JSON-serializable`);
      const snapshot = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${label} must be JSON-serializable`);
        snapshot.push(jsonSnapshot(descriptor.value, label, ancestors));
      }
      return snapshot;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be JSON-serializable`);
    const keys = Reflect.ownKeys(value);
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) invalid(`${label} must be JSON-serializable`);
      return [key, jsonSnapshot(descriptor.value, label, ancestors)];
    });
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function freezeSnapshot(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function decodedSelection(fields, publisherResponse) {
  Object.defineProperty(fields, "publisherResponse", { value: freezeSnapshot(publisherResponse) });
  return Object.freeze(fields);
}

function selectionEvidence(value) {
  const evidence = record(value, "publisher decision artifact");
  if (!Array.isArray(evidence.command) || evidence.command.length === 0) {
    invalid("publisher decision command must be a non-empty opaque array");
  }
  if (![evidence.result, evidence.artifact].some(isNonEmptyOpaqueEvidence)) {
    invalid("publisher decision result or artifact must be non-empty opaque evidence");
  }
  return evidence;
}

function isNonEmptyOpaqueEvidence(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length > 0;
}

/**
 * Check only the stable publisher-selection transport. Work-result schemas,
 * readiness semantics, and diagnostic-code meanings remain publisher-owned.
 */
export function decodePublisherWorkSelection(request, response) {
  const selectionRequest = record(request, "request");
  if (selectionRequest.capability !== PUBLISHER_WORK_SELECTION_CAPABILITY) invalid("unsupported requested capability");
  const requested = record(selectionRequest.request, "request.request");
  if (typeof requested.workItemId !== "string" || requested.workItemId === "") invalid("request work identity is required");
  if (!Object.hasOwn(requested, "invocationContext")) invalid("request invocation context is required");

  // Snapshot the publisher's untrusted transport once. This excludes inherited
  // and non-enumerable fields and guarantees returned evidence is journal-safe.
  const publisherResponse = jsonSnapshot(response, "response");
  if (publisherResponse.capability !== PUBLISHER_WORK_SELECTION_CAPABILITY) invalid("unsupported publisher capability or version");
  const decisionArtifact = selectionEvidence(publisherResponse.decisionArtifact);
  const outcome = record(publisherResponse.outcome, "publisher outcome");

  if (outcome.kind === "selected") {
    if (typeof outcome.workItemId !== "string" || outcome.workItemId === "") invalid("selected work identity is required");
    if (outcome.workItemId !== requested.workItemId) invalid("publisher selected a different work identity");
    return decodedSelection({
      kind: "selected",
      workItemId: outcome.workItemId,
      capability: publisherResponse.capability,
      decisionArtifact,
    }, publisherResponse);
  }
  if (outcome.kind === "not-selected" && typeof outcome.code === "string" && outcome.code !== "") {
    return decodedSelection({
      kind: "not-selected",
      code: outcome.code,
      capability: publisherResponse.capability,
      decisionArtifact,
    }, publisherResponse);
  }
  invalid("publisher outcome is malformed");
}
