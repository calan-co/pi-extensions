import { readFile } from "node:fs/promises";
import path from "node:path";
import { builtInCommands, parseRepositoryOverride } from "./doc-vader-contract.mjs";

const DEFAULT_OVERRIDE = ".babysitter/repository-override.json";

/** Loads only the explicit versioned argv override; policy controls remain built in. */
export async function loadRepositoryOverride({ repositoryRoot, repositoryOverridePath = path.join(repositoryRoot ?? "", DEFAULT_OVERRIDE) } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new TypeError("repository root is required");
  let contents;
  try { contents = await readFile(repositoryOverridePath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ source: "built-in", commands: builtInCommands });
    throw new Error("Repository override is unreadable");
  }
  let override;
  try { override = JSON.parse(contents); } catch { throw new Error("Repository override is malformed JSON"); }
  try { parseRepositoryOverride(override); } catch (error) { throw new Error(`Repository override is invalid: ${error.message}`); }
  const commands = Object.fromEntries(Object.entries(builtInCommands).map(([name, command]) => [name, (workId) => {
    const argv = override.commands[name] ?? command(workId);
    return argv.map((token) => token === "{workId}" ? workId : token);
  }]));
  return Object.freeze({ source: repositoryOverridePath, commands: Object.freeze(commands) });
}
