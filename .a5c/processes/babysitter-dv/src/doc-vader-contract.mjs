const CONTRACT_VERSION = "doc-vader-contract/v1";

function invalid(message) {
  throw new TypeError(`Invalid repository command override: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
}

/**
 * Validate only the Babysitter-owned repository command-argv compatibility
 * declaration. Publisher command results remain opaque to Babysitter.
 */
export function parseRepositoryOverride(override) {
  requireObject(override, "override");
  if (override.schemaVersion !== "doc-vader-override/v1") invalid(`unsupported schema version ${String(override.schemaVersion)}`);
  requireArray(override.compatibleWith, "compatibleWith");
  if (!override.compatibleWith.every((version) => typeof version === "string")) invalid("compatibleWith must contain only strings");
  if (!override.compatibleWith.includes(CONTRACT_VERSION)) invalid(`override is not compatible with ${CONTRACT_VERSION}`);
  requireObject(override.commands, "commands");
  const commandNames = new Set(["ready", "show", "validate", "close"]);
  for (const [name, argv] of Object.entries(override.commands)) {
    if (!commandNames.has(name)) invalid(`unknown override command ${name}`);
    requireArray(argv, `commands.${name}`);
    if (argv.length === 0 || !argv.every((token) => typeof token === "string" && token.length > 0)) invalid(`commands.${name} must be a non-empty string argv`);
    if (!argv.includes("--json")) invalid(`commands.${name} must request structured JSON output`);
    if (name !== "ready" && !argv.includes("{workId}")) invalid(`commands.${name} must include {workId}`);
  }
  return override;
}

/** Built-in command argv compatibility defaults; no result decoder is supplied. */
export const builtInCommands = Object.freeze({
  ready: () => ["dv", "work", "ready", "--json"],
  show: (workId) => ["dv", "work", "show", workId, "--json"],
  validate: (workId) => ["dv", "work", "status", workId, "--validate", "--json"],
  close: (workId) => ["dv", "work", "close", workId, "--json"],
});
