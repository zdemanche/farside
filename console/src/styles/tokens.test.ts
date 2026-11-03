/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const EVERGREEN = join(SRC, "styles", "evergreen-theme.css");
const TOKENS = join(SRC, "styles", "tokens.css");
const THEME_GUARD = join(ROOT, "public", "theme-guard.js");

const VENDORED_SHA256 = new Map([
  [EVERGREEN, "bc51ec74e96c2e7a9be2fea1e8b0a41d84d5f9d62f73778e719850c708bcf06a"],
  [TOKENS, "25fe2cae70bc6a551c9f995a2d4ba1a1c2dc62a8bff77dfbb331f46aab9f6227"],
  [THEME_GUARD, "a54fa061c583bb72682e8b0b75c5fe9cc68a27e3b95660e99f855bd5e80b04e7"],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (path === EVERGREEN || path === TOKENS) return [];
    if (/\.test\.tsx?$/.test(name)) return [];
    return /\.(css|tsx)$/.test(name) ? [path] : [];
  });
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

const NAMED_COLOURS =
  "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|teal|navy|maroon|cyan|magenta|lime|olive|aqua|fuchsia|brown|gold";
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/;
const NAMED_COLOUR_DECLARATION = new RegExp(
  `\\b(color|background(-color)?|border(-[a-z]+)*|outline(-color)?|fill|stroke)\\s*:[^;{}]*\\b(${NAMED_COLOURS})\\b`,
  "i",
);
const RAW_LENGTH = /(?<![\w.-])-?\d*\.?\d+(px|rem)\b/;
const RAW_DURATION = /(?<![\w.-])\d*\.?\d+(ms|s)\b/;

function lines(file: string): { text: string; number: number }[] {
  const source = readFileSync(file, "utf8");
  const code = file.endsWith(".css") ? withoutComments(source) : source;
  return code.split("\n").map((text, index) => ({ text, number: index + 1 }));
}

function violations(files: string[], rules: [string, RegExp][]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const { text, number } of lines(file)) {
      if (/^\s*@media\b/.test(text)) continue;
      for (const [label, rule] of rules) {
        if (rule.test(text)) found.push(`${relative(SRC, file)}:${number} ${label}  ${text.trim()}`);
      }
    }
  }
  return found;
}

const files = sources(SRC);
const cssFiles = files.filter((file) => file.endsWith(".css"));
const tsxFiles = files.filter((file) => file.endsWith(".tsx"));

describe("design tokens only outside the vendored files", () => {
  it("scans the component layer", () => {
    expect(cssFiles.map((file) => relative(SRC, file))).toEqual(
      expect.arrayContaining(["styles/console.css", "styles/index.css"]),
    );
    expect(tsxFiles.length).toBeGreaterThan(0);
  });

  it("has no raw colour in CSS or TSX", () => {
    expect(
      violations(cssFiles, [
        ["hex colour", HEX],
        ["colour function", COLOUR_FUNCTION],
        ["named colour", NAMED_COLOUR_DECLARATION],
      ]),
    ).toEqual([]);
    expect(
      violations(tsxFiles, [
        ["hex colour", HEX],
        ["colour function", COLOUR_FUNCTION],
      ]),
    ).toEqual([]);
  });

  it("has no raw length or duration in CSS (media query breakpoints cannot use var())", () => {
    expect(
      violations(cssFiles, [
        ["raw length", RAW_LENGTH],
        ["raw duration", RAW_DURATION],
      ]),
    ).toEqual([]);
  });

  it("has no inline style in TSX", () => {
    expect(violations(tsxFiles, [["inline style", /\bstyle=\{/]])).toEqual([]);
  });

  it("catches what it claims to catch", () => {
    expect(HEX.test("color: #fff;")).toBe(true);
    expect(COLOUR_FUNCTION.test("background: rgb(0 0 0);")).toBe(true);
    expect(NAMED_COLOUR_DECLARATION.test("border: 1px solid red;")).toBe(true);
    expect(NAMED_COLOUR_DECLARATION.test("color: var(--ink);")).toBe(false);
    expect(RAW_LENGTH.test("padding: 8px;")).toBe(true);
    expect(RAW_LENGTH.test("padding: var(--space-8);")).toBe(false);
    expect(RAW_DURATION.test("transition: color 200ms;")).toBe(true);
    expect(RAW_DURATION.test("transition: color var(--duration-fast);")).toBe(false);
  });
});

describe("vendored Moonaan files", () => {
  it.each([...VENDORED_SHA256])("%s is unchanged", (file, expected) => {
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(
      actual,
      "update the vendored file by copying from moonaan-identity and bump the hash",
    ).toBe(expected);
  });
});

function declaredNames(body: string): string[] {
  return [...body.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] as string);
}

function rootBlock(css: string, opening: string): string {
  const start = css.indexOf(opening);
  expect(start, `${opening} block`).toBeGreaterThanOrEqual(0);
  return css.slice(start + opening.length, css.indexOf("\n}", start));
}

describe("theme parity", () => {
  const evergreen = readFileSync(EVERGREEN, "utf8");

  it("defines the same base colour names in the Moonaan and Daylight modes", () => {
    const moonaanBlock = rootBlock(evergreen, ":root {");
    const moonaanBase = declaredNames(moonaanBlock.slice(0, moonaanBlock.indexOf("derived:")));
    const daylight = declaredNames(rootBlock(evergreen, '[data-theme="daylight"] {'));
    expect(moonaanBase.length).toBeGreaterThan(20);
    expect([...daylight].sort()).toEqual([...moonaanBase].sort());
  });

  it("declares every --color-* once, outside any theme block", () => {
    const tokens = withoutComments(readFileSync(TOKENS, "utf8"));
    const names: string[] = [];
    for (const block of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const colours = declaredNames(block[2] as string).filter((name) => name.startsWith("--color-"));
      if (colours.length === 0) continue;
      expect((block[1] as string).trim(), "selector of a --color-* block").toBe(":root");
      names.push(...colours);
    }
    expect(names.length).toBeGreaterThan(40);
    expect(new Set(names).size).toBe(names.length);
  });
});
