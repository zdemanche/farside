#!/usr/bin/env node
// Claim rehearsal on a Moonaan Identity test tenant (E2-S1-T5, #51).
//
// Given a running Farside backend with FARSIDE_IDENTITY_* pointed at the test tenant, and
// test-user tokens from that tenant, runs: header stand-in refused -> claim -> claim again
// (idempotent) -> sign-in -> optional join -> org-scoped read -> cross-org 403, then writes a
// dated record to docs/identity/run-records/. Tokens never reach the record.
//
// Without a test tenant configured it prints "skipped: no identity test tenant" and exits 0.
// See scripts/identity-rehearsal/checklist.md.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_OUT_DIR = join(ROOT, "docs/identity/run-records");
export const SKIPPED = "skipped: no identity test tenant";
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const REQUIRED = ["FARSIDE_REHEARSAL_API_URL", "FARSIDE_REHEARSAL_ISSUER", "FARSIDE_REHEARSAL_OWNER_TOKEN"];

/** Reads a JWT payload without verifying it: the backend verifies; the runner only needs claims. */
export function claimsOf(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

function claimValue(claims, name) {
  if (name in claims) {
    return claims[name];
  }
  return name.split(".").reduce((current, part) => (current && typeof current === "object" ? current[part] : undefined), claims);
}

/** Returns `{ skip: true }`, `{ errors }` or `{ config }`. */
export function configFrom(env) {
  const value = (key) => (typeof env[key] === "string" && env[key].trim() !== "" ? env[key].trim() : undefined);
  if (REQUIRED.every((key) => !value(key))) {
    return { skip: true };
  }
  const errors = REQUIRED.filter((key) => !value(key)).map((key) => `${key} is required`);
  const orgClaim = value("FARSIDE_REHEARSAL_ORG_CLAIM");
  const orgOf = (token) => (token && orgClaim ? claimValue(claimsOf(token), orgClaim) : undefined);
  const owner = value("FARSIDE_REHEARSAL_OWNER_TOKEN");
  const other = value("FARSIDE_REHEARSAL_OTHER_TOKEN");
  const orgId = value("FARSIDE_REHEARSAL_ORG") ?? orgOf(owner);
  const otherOrgId = value("FARSIDE_REHEARSAL_OTHER_ORG") ?? orgOf(other);
  if (owner && (typeof orgId !== "string" || !ORG_ID.test(orgId))) {
    errors.push("set FARSIDE_REHEARSAL_ORG, or FARSIDE_REHEARSAL_ORG_CLAIM to read it from the owner token");
  }
  if (typeof otherOrgId !== "string" || !ORG_ID.test(otherOrgId)) {
    errors.push("set FARSIDE_REHEARSAL_OTHER_ORG or FARSIDE_REHEARSAL_OTHER_TOKEN (a user of a second tenant) for the cross-org check");
  } else if (otherOrgId === orgId) {
    errors.push("the cross-org check needs a different org than the owner's");
  }
  const issuer = value("FARSIDE_REHEARSAL_ISSUER");
  for (const [name, token] of [
    ["owner", owner],
    ["member", value("FARSIDE_REHEARSAL_MEMBER_TOKEN")],
    ["other", other],
  ]) {
    if (token && issuer && claimsOf(token).iss !== issuer) {
      errors.push(`the ${name} token was not issued by FARSIDE_REHEARSAL_ISSUER`);
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    config: {
      apiUrl: value("FARSIDE_REHEARSAL_API_URL").replace(/\/+$/, ""),
      issuer,
      orgId,
      otherOrgId,
      tokens: { owner, member: value("FARSIDE_REHEARSAL_MEMBER_TOKEN"), other },
    },
  };
}

async function call(fetchImpl, url, { method = "GET", token, headers = {} } = {}) {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function step(id, expected, response, ok, detail) {
  return {
    id,
    expected,
    status: response.status,
    ok,
    ...(detail ? { detail } : {}),
    ...(response.error ? { detail: `request failed: ${response.error}` } : {}),
  };
}

export async function runSteps(config, fetchImpl = fetch) {
  const { apiUrl, orgId, otherOrgId, tokens } = config;
  const org = (id, path) => `${apiUrl}/v1/orgs/${encodeURIComponent(id)}${path}`;
  const steps = [];

  const stand = await call(fetchImpl, org(orgId, "/settings"), {
    headers: { "x-farside-org": orgId, "x-farside-actor": "rehearsal" },
  });
  steps.push(step("header-stand-in-refused", "401", stand, stand.status === 401, stand.status === 401 ? undefined : "backend still accepts the header session: is FARSIDE_IDENTITY_ISSUER set?"));

  const claim = await call(fetchImpl, org(orgId, "/claim"), { method: "POST", token: tokens.owner });
  const claimedOk = (claim.status === 201 || claim.status === 200) && claim.body?.role === "owner";
  steps.push(
    step("claim", "201 claimed, or 200 existing on a re-run, role owner", claim, claimedOk, claim.body?.outcome ? `outcome ${claim.body.outcome}, role ${claim.body.role}` : undefined),
  );

  const again = await call(fetchImpl, org(orgId, "/claim"), { method: "POST", token: tokens.owner });
  steps.push(step("claim-idempotent", "200 existing, role owner", again, again.status === 200 && again.body?.outcome === "existing" && again.body?.role === "owner"));

  const signIn = await call(fetchImpl, org(orgId, "/claim"), { token: tokens.owner });
  steps.push(step("sign-in", "200 member, role owner", signIn, signIn.status === 200 && signIn.body?.member === true && signIn.body?.role === "owner"));

  if (tokens.member) {
    const join = await call(fetchImpl, org(orgId, "/claim"), { method: "POST", token: tokens.member });
    steps.push(step("join", "200 joined or existing, role member", join, join.status === 200 && join.body?.role === "member", join.body?.outcome ? `outcome ${join.body.outcome}` : undefined));
  }

  const read = await call(fetchImpl, org(orgId, "/settings"), { token: tokens.owner });
  steps.push(step("org-scoped-read", "200", read, read.status === 200));

  const cross = await call(fetchImpl, org(otherOrgId, "/settings"), { token: tokens.owner });
  steps.push(step("cross-org-403", "403 reading the other org with the owner token", cross, cross.status === 403));

  if (tokens.other) {
    const intruder = await call(fetchImpl, org(orgId, "/settings"), { token: tokens.other });
    steps.push(step("cross-org-403-reverse", "403 reading the owner's org with the other tenant's token", intruder, intruder.status === 403));
    const takeover = await call(fetchImpl, org(orgId, "/claim"), { method: "POST", token: tokens.other });
    steps.push(step("cross-org-claim-403", "403 claiming the owner's org from the other tenant", takeover, takeover.status === 403));
  }
  return steps;
}

function recordPath(outDir, date) {
  let path = join(outDir, `${date}-claim-rehearsal.json`);
  for (let n = 2; existsSync(path); n += 1) {
    path = join(outDir, `${date}-claim-rehearsal-${n}.json`);
  }
  return path;
}

/**
 * Runs the rehearsal. Returns `{ status: "skipped" }`, `{ status: "invalid", errors }`,
 * or `{ status: "pass" | "fail", record, file }`.
 */
export async function rehearse({ env = process.env, fetch: fetchImpl = fetch, now = () => new Date(), outDir = DEFAULT_OUT_DIR } = {}) {
  const parsed = configFrom(env);
  if (parsed.skip) {
    return { status: "skipped" };
  }
  if (parsed.errors) {
    return { status: "invalid", errors: parsed.errors };
  }
  const { config } = parsed;
  const steps = await runSteps(config, fetchImpl);
  const ranAt = now().toISOString();
  const result = steps.every((item) => item.ok) ? "pass" : "fail";
  const record = {
    kind: "identity-claim-rehearsal",
    issue: 51,
    liveRunAt: ranAt.slice(0, 10),
    ranAt,
    issuer: config.issuer,
    apiUrl: config.apiUrl,
    orgId: config.orgId,
    otherOrgId: config.otherOrgId,
    memberChecked: Boolean(config.tokens.member),
    result,
    steps,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  for (const token of Object.values(config.tokens)) {
    if (token && serialized.includes(token)) {
      throw new Error("refusing to write a rehearsal record that contains a token");
    }
  }
  mkdirSync(outDir, { recursive: true });
  const file = recordPath(outDir, record.liveRunAt);
  writeFileSync(file, serialized);
  return { status: result, record, file };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const outcome = await rehearse({ outDir: process.env.FARSIDE_REHEARSAL_OUT || DEFAULT_OUT_DIR });
  if (outcome.status === "skipped") {
    console.log(SKIPPED);
  } else if (outcome.status === "invalid") {
    for (const error of outcome.errors) {
      console.error(`identity rehearsal: ${error}`);
    }
    process.exit(1);
  } else {
    for (const item of outcome.record.steps) {
      console.log(`${item.ok ? "ok  " : "FAIL"} ${item.id} (got ${item.status}, want ${item.expected})${item.detail ? `: ${item.detail}` : ""}`);
    }
    console.log(`${outcome.status}: record written to ${outcome.file}`);
    process.exit(outcome.status === "pass" ? 0 : 1);
  }
}
