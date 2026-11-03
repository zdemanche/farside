/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const EVERGREEN = join(SRC, "styles", "evergreen-theme.css");
const TOKENS = join(SRC, "styles", "tokens.css");
const PUBLIC = join(ROOT, "public");
const THEME_GUARD = join(PUBLIC, "theme-guard.js");

const VENDORED_SHA256 = new Map([
  [EVERGREEN, "bc51ec74e96c2e7a9be2fea1e8b0a41d84d5f9d62f73778e719850c708bcf06a"],
  [TOKENS, "25fe2cae70bc6a551c9f995a2d4ba1a1c2dc62a8bff77dfbb331f46aab9f6227"],
  [THEME_GUARD, "a54fa061c583bb72682e8b0b75c5fe9cc68a27e3b95660e99f855bd5e80b04e7"],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const VENDORED = new Set(VENDORED_SHA256.keys());
const scanned = [
  ...walk(SRC),
  ...walk(PUBLIC),
  join(ROOT, "index.html"),
].filter((file) => !VENDORED.has(file) && !/\.test\.tsx?$/.test(file));

const byExtension = (...extensions: string[]) =>
  scanned.filter((file) => extensions.some((extension) => file.endsWith(extension)));

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function codeOf(line: string): string {
  return line.replace(/@media[^{]*/, "").replace(/var\([^)]*\)/g, "var()");
}

const NAMES =
  "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|teal|navy|maroon|cyan|magenta|lime|olive|aqua|fuchsia|brown|gold";
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/;
const NAMED_COLOUR = new RegExp(
  `\\b(color|background(-[a-z]+)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-shadow)\\s*:[^;{}]*\\b(${NAMES})\\b|gradient\\([^)]*\\b(${NAMES})\\b`,
  "i",
);
const RAW_LENGTH = /(?<![\w.-])-?\d*\.?\d+(px|rem|em|ch|vw|vh|pt)\b/;
const RAW_DURATION = /(?<![\w.-])\d*\.?\d+(ms|s)\b/;
const INLINE_STYLE = /\bstyle\s*=/;

type Rule = [string, RegExp];

function violations(files: string[], rules: Rule[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const code = file.endsWith(".css") ? withoutComments(source) : source;
    code.split("\n").forEach((line, index) => {
      const text = codeOf(line);
      for (const [label, rule] of rules) {
        if (rule.test(text)) found.push(`${relative(ROOT, file)}:${index + 1} ${label}  ${line.trim()}`);
      }
    });
  }
  return found;
}

const COLOURS: Rule[] = [
  ["hex colour", HEX],
  ["colour function", COLOUR_FUNCTION],
];

describe("design tokens only outside the vendored files", () => {
  it("scans the component layer, sources, html and public scripts", () => {
    const names = scanned.map((file) => relative(ROOT, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "src/styles/console.css",
        "src/styles/index.css",
        "src/App.tsx",
        "src/shell.ts",
        "index.html",
      ]),
    );
    expect(names).not.toContain("public/theme-guard.js");
  });

  it("has no raw colour in CSS, TSX, TS, HTML or public scripts", () => {
    expect(
      violations(byExtension(".css"), [...COLOURS, ["named colour", NAMED_COLOUR]]),
    ).toEqual([]);
    expect(violations(byExtension(".tsx", ".ts", ".html", ".js"), COLOURS)).toEqual([]);
  });

  it("has no raw length or duration in CSS (only an @media condition may, since var() is not allowed there)", () => {
    expect(
      violations(byExtension(".css"), [
        ["raw length", RAW_LENGTH],
        ["raw duration", RAW_DURATION],
      ]),
    ).toEqual([]);
  });

  it("has no inline style", () => {
    expect(
      violations(byExtension(".tsx", ".ts", ".html", ".js"), [["inline style", INLINE_STYLE]]),
    ).toEqual([]);
  });

  it("catches what it claims to catch", () => {
    expect(HEX.test("color: #fff;")).toBe(true);
    expect(COLOUR_FUNCTION.test("background: rgb(0 0 0);")).toBe(true);
    expect(COLOUR_FUNCTION.test("color: hwb(0 0% 0%);")).toBe(true);
    expect(COLOUR_FUNCTION.test("color: oklch(0.5 0.1 20);")).toBe(true);
    expect(NAMED_COLOUR.test("border: 1px solid red;")).toBe(true);
    expect(NAMED_COLOUR.test("box-shadow: 0 0 var(--space-4) black;")).toBe(true);
    expect(NAMED_COLOUR.test("background-image: linear-gradient(red, var(--ink));")).toBe(true);
    expect(NAMED_COLOUR.test(codeOf("color: var(--pink);"))).toBe(false);
    expect(RAW_LENGTH.test("padding: 8px;")).toBe(true);
    expect(RAW_LENGTH.test("padding: 1.5em;")).toBe(true);
    expect(RAW_LENGTH.test("width: 40ch;")).toBe(true);
    expect(RAW_LENGTH.test("padding: var(--space-8);")).toBe(false);
    expect(RAW_LENGTH.test(codeOf("@media (min-width: 48em) {"))).toBe(false);
    expect(RAW_LENGTH.test(codeOf("@media (min-width: 48em) { .a { margin: 8px; } }"))).toBe(true);
    expect(RAW_LENGTH.test(codeOf(".a { margin: 8px; }"))).toBe(true);
    expect(RAW_DURATION.test("transition: color 200ms;")).toBe(true);
    expect(RAW_DURATION.test("transition: color var(--duration-fast);")).toBe(false);
    expect(INLINE_STYLE.test('<div style={{ width: 3 }} />')).toBe(true);
    expect(INLINE_STYLE.test('<div style = "x" />')).toBe(true);
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
