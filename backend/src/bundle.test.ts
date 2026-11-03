import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const BACKEND = fileURLToPath(new URL("..", import.meta.url));
let dir = "";

async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(String(port)));
    });
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "farside-bundle-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  execFileSync("node", [join(BACKEND, "bundle.mjs"), dir], { cwd: BACKEND });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("serves /health from a directory without docs/", async () => {
  const PORT = await freePort();
  const child = spawn("node", [join(dir, "index.js")], {
    cwd: dir,
    env: { ...process.env, PORT, HOST: "127.0.0.1", FARSIDE_LOG_LEVEL: "silent" },
    stdio: "ignore",
  });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 50 && !response?.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => undefined);
    }
    expect(await response?.json()).toEqual({ status: "ok", service: "farside" });
  } finally {
    child.kill();
  }
});

it("bundles the lambda handler with the docs JSON", async () => {
  const bundled = (await import(join(dir, "lambda.mjs"))) as typeof import("./lambda.js");
  const result = await bundled.handler({ rawPath: "/health" });
  expect(result.statusCode).toBe(200);
});

it("bundles the scheduled tick handler", async () => {
  const bundled = (await import(join(dir, "scheduled.mjs"))) as typeof import("./scheduled.js");
  expect(await bundled.handler()).toEqual({ orgs: [], retired: 0 });
});
