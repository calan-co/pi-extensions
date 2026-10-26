import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SCRIPT_ORDER = ["check", "build", "test", "lint"];
const LOCKFILES = new Map([
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
]);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`Cannot parse declared package metadata: ${file}`);
  }
}

async function exists(file) {
  try { await readFile(file); return true; } catch { return false; }
}

function workspacePatterns(rootPackage) {
  if (!Object.hasOwn(rootPackage, "workspaces")) return [];
  const declared = rootPackage.workspaces;
  if (!Array.isArray(declared) || declared.some((item) => typeof item !== "string" || !item || item.startsWith("!"))) {
    throw new Error("Unparseable declared workspaces");
  }
  return declared;
}

function matchesPattern(directory, pattern) {
  const normalized = directory.split(path.sep).join("/");
  const expression = pattern.split("/").map((segment) => segment === "**"
    ? ".*"
    : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
  ).join("/");
  return new RegExp(`^${expression}$`).test(normalized);
}

async function packageFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const childRelative = path.join(relative, entry.name);
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await packageFiles(child, childRelative));
    else if (entry.isFile() && entry.name === "package.json") files.push(childRelative);
  }
  return files;
}

async function discoverWorkspaces(repositoryRoot, patterns) {
  const files = await packageFiles(repositoryRoot);
  const workspaces = [];
  for (const packageFile of files) {
    if (packageFile === "package.json") continue;
    const directory = path.dirname(packageFile);
    const matchingPatterns = patterns.filter((pattern) => matchesPattern(directory, pattern));
    if (matchingPatterns.length === 0) continue;
    if (matchingPatterns.length > 1) throw new Error("Ambiguous workspace graph");
    const manifest = await readJson(path.join(repositoryRoot, packageFile));
    if (typeof manifest.name !== "string" || !manifest.name) throw new Error("Unparseable workspace graph");
    workspaces.push({ name: manifest.name, directory, manifest });
  }
  const names = new Set();
  if (workspaces.some(({ name }) => names.has(name) || !names.add(name))) throw new Error("Ambiguous workspace graph");
  return workspaces.sort((a, b) => a.directory.localeCompare(b.directory));
}

function dependencyNames(manifest) {
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  if (sections.some((section) => section !== undefined && (section === null || Array.isArray(section) || typeof section !== "object" || Object.values(section).some((value) => typeof value !== "string")))) {
    throw new Error("Unparseable workspace graph");
  }
  return Object.keys(Object.assign({}, ...sections));
}

function validateWorkspaceGraph(workspaces) {
  for (const { manifest } of workspaces) dependencyNames(manifest);
  for (let index = 0; index < workspaces.length; index += 1) {
    const directory = workspaces[index].directory;
    if (workspaces.slice(index + 1).some((workspace) => workspace.directory.startsWith(`${directory}/`))) {
      throw new Error("Ambiguous workspace graph");
    }
  }
}

function commandsFor(workspaces) {
  return workspaces.flatMap(({ name, manifest }) => SCRIPT_ORDER
    .filter((script) => typeof manifest.scripts?.[script] === "string" && manifest.scripts[script])
    .map((script) => ({ workspace: name, script })));
}

async function validatePackageManager(repositoryRoot, rootPackage) {
  const locks = [];
  for (const [file, manager] of LOCKFILES) if (await exists(path.join(repositoryRoot, file))) locks.push(manager);
  if (locks.length !== 1) throw new Error("Ambiguous or missing Node lockfile configuration");
  if (Object.hasOwn(rootPackage, "packageManager")) {
    const declaration = rootPackage.packageManager;
    const match = typeof declaration === "string" && /^(pnpm|npm|yarn)@(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(declaration);
    if (!match || match[1] !== locks[0]) throw new Error("Ambiguous Node package-manager configuration");
  }
}

function ownerFor(changedPath, workspaces) {
  if (typeof changedPath !== "string" || path.isAbsolute(changedPath) || /^[A-Za-z]:[\\/]/.test(changedPath) || changedPath.startsWith("\\")) throw new Error("Changed path is outside declared workspaces");
  const normalized = path.posix.normalize(changedPath.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Changed path is outside declared workspaces");
  const owners = workspaces.filter(({ directory }) => directory === "" || normalized === directory || normalized.startsWith(`${directory}/`));
  if (owners.length === 0) throw new Error("Changed path is outside declared workspaces");
  if (owners.length > 1) throw new Error("Ambiguous workspace ownership");
  return owners[0];
}

export function createNodeAcceptanceDiscoveryAdapter() {
  return {
    async plan({ repositoryRoot, candidate, changedPaths }) {
      if (typeof repositoryRoot !== "string" || !Array.isArray(changedPaths)) throw new Error("Invalid acceptance plan input");
      const rootPackage = await readJson(path.join(repositoryRoot, "package.json"));
      await validatePackageManager(repositoryRoot, rootPackage);
      const patterns = workspacePatterns(rootPackage);
      if (candidate !== "implementation" && candidate !== "integration") throw new Error("Unknown acceptance candidate");
      const workspaces = patterns.length === 0
        ? [{ name: rootPackage.name, directory: "", manifest: rootPackage }]
        : await discoverWorkspaces(repositoryRoot, patterns);
      validateWorkspaceGraph(workspaces);
      if (candidate === "integration") {
        return {
          scope: "repository",
          workspaces: [],
          commands: commandsFor([{ name: "root", manifest: rootPackage }]),
        };
      }
      const affected = new Set();
      const selected = [];
      const add = (workspace) => {
        if (!affected.has(workspace.name)) {
          affected.add(workspace.name);
          selected.push(workspace);
        }
      };
      for (const changedPath of changedPaths) add(ownerFor(changedPath, workspaces));
      for (let index = 0; index < selected.length; index += 1) {
        const dependency = selected[index].name;
        for (const workspace of workspaces) {
          if (dependencyNames(workspace.manifest).includes(dependency)) add(workspace);
        }
      }
      return { scope: "affected-workspaces", workspaces: selected.map(({ name }) => name), commands: commandsFor(selected) };
    },

    async execute(plan, runCommand) {
      if (!plan || !Array.isArray(plan.commands) || typeof runCommand !== "function") {
        throw new Error("Invalid acceptance execution input");
      }
      const results = [];
      for (const command of plan.commands) results.push(await runCommand(command));
      return { plan, results };
    },
  };
}
