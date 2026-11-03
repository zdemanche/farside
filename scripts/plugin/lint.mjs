#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST = join(ROOT, "plugin/.claude-plugin/plugin.json");
const DEFAULT_PACKAGE = join(ROOT, "package.json");
const DEFAULT_SKILL = join(ROOT, "plugin/skills/findings-method/SKILL.md");
const DEFAULT_COMMANDS = join(ROOT, "plugin/commands");
const COMMAND_NAMES = ["connect", "scan", "findings"];
const DEFAULT_WORKSPACE_PHRASE = "farside-engagements";

export const FINDINGS_SKILL_PHRASES = [
  "issue id",
  "assessed",
  "not assessed",
  "undetermined",
  "closer",
  "range",
];

export const PLUGIN_NAME = "farside";
export const PLUGIN_AUTHOR = "Moonaan, LLC";
export const PLUGIN_LICENSE = "UNLICENSED";

export function lintPluginManifest(manifest, productVersion) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["plugin.json must be an object"];
  }
  if (manifest.name !== PLUGIN_NAME) {
    errors.push(`name must be '${PLUGIN_NAME}'`);
  }
  if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author)) {
    errors.push("author must be an object");
  } else if (manifest.author.name !== PLUGIN_AUTHOR) {
    errors.push(`author.name must be '${PLUGIN_AUTHOR}'`);
  }
  if (manifest.license !== PLUGIN_LICENSE) {
    errors.push(`license must be '${PLUGIN_LICENSE}'`);
  }
  const skills = manifest.skills;
  if (!Array.isArray(skills) || !skills.some((skill) => skill === "./skills" || skill === "./skills/findings-method")) {
    errors.push("skills must include './skills'");
  }
  const commands = manifest.commands;
  if (!Array.isArray(commands) || !commands.includes("./commands")) {
    errors.push("commands must include './commands'");
  }
  if (typeof productVersion !== "string" || productVersion.length === 0) {
    errors.push("product version is required");
  } else if (manifest.version !== productVersion) {
    errors.push(`version must match the product version '${productVersion}'`);
  }
  return errors;
}

export function lintPluginCommands(commandsDir = DEFAULT_COMMANDS) {
  const errors = [];
  for (const name of COMMAND_NAMES) {
    let markdown;
    try {
      markdown = readFileSync(join(commandsDir, `${name}.md`), "utf8");
    } catch (error) {
      errors.push(`command '${name}' is missing: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (!markdown.startsWith("---")) {
      errors.push(`command '${name}' must have YAML frontmatter`);
    }
    if (!/^description:\s.+/m.test(markdown)) {
      errors.push(`command '${name}' must set description frontmatter`);
    }
    if (!markdown.includes(DEFAULT_WORKSPACE_PHRASE)) {
      errors.push(`command '${name}' must default the workspace to ${DEFAULT_WORKSPACE_PHRASE}`);
    }
    if (!markdown.includes(`bin/farside.mjs ${name}`)) {
      errors.push(`command '${name}' must wrap one CLI call`);
    }
  }
  return errors;
}

export function lintFindingsMethodSkill(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return ["findings-method skill is empty"];
  }
  const errors = [];
  const lower = markdown.toLowerCase();
  for (const phrase of FINDINGS_SKILL_PHRASES) {
    if (!lower.includes(phrase)) {
      errors.push(`findings-method skill is missing '${phrase}'`);
    }
  }
  if (!lower.includes("did not produce") && !lower.includes("cli did not")) {
    errors.push("findings-method skill must forbid findings the CLI did not produce");
  }
  return errors;
}

export function lintPluginManifestFile(
  manifestPath = DEFAULT_MANIFEST,
  packagePath = DEFAULT_PACKAGE,
  skillPath = DEFAULT_SKILL,
) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`plugin.json is not valid JSON: ${error instanceof Error ? error.message : error}`];
  }
  let product;
  try {
    product = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return [`package.json is not valid JSON: ${error instanceof Error ? error.message : error}`];
  }
  let skill;
  try {
    skill = readFileSync(skillPath, "utf8");
  } catch (error) {
    return [`findings-method skill is missing: ${error instanceof Error ? error.message : error}`];
  }
  return [
    ...lintPluginManifest(manifest, product.version),
    ...lintFindingsMethodSkill(skill),
    ...lintPluginCommands(),
  ];
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintPluginManifestFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log("plugin manifest ok");
}
