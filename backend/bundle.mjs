import { build } from "esbuild";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const SHARED = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

export async function bundle(outdir) {
  const root = fileURLToPath(new URL("./", import.meta.url));
  await build({ ...SHARED, entryPoints: [`${root}src/index.ts`], outdir });
  await build({
    ...SHARED,
    entryPoints: [`${root}src/lambda.ts`, `${root}src/scheduled.ts`],
    outdir,
    outExtension: { ".js": ".mjs" },
    external: ["@aws-sdk/*"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle(process.argv[2] ?? fileURLToPath(new URL("./dist", import.meta.url)));
}
