/**
 * Writes Pulumi.<customer>.yaml for one customer and prints the stack as JSON.
 *
 *   npx tsx src/customer-cli.ts --customer <slug> --account <12 digits> \
 *     [--registry accounts.json] [--customers customers.json] [--write]
 *
 * Without --write it prints only (dry run). Exit 1 on any guard failure.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAccountRegistry } from "./account.js";
import { customerStack, loadCustomerCatalogue, renderStackYaml } from "./customer.js";

export function runCustomerCli(argv: string[], cwd = process.cwd()): { code: number; output: string } {
  const flags = new Map<string, string>();
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--write") {
      write = true;
    } else if (arg.startsWith("--")) {
      flags.set(arg.slice(2), argv[index + 1] ?? "");
      index += 1;
    } else {
      return { code: 2, output: `unexpected argument ${arg}` };
    }
  }
  const customer = flags.get("customer");
  const account = flags.get("account");
  if (!customer || !account) {
    return { code: 2, output: "usage: customer-cli --customer <slug> --account <id> [--registry f] [--customers f] [--write]" };
  }
  try {
    const stack = customerStack(
      customer,
      account,
      loadCustomerCatalogue(resolve(cwd, flags.get("customers") ?? "customers.json")),
      loadAccountRegistry(resolve(cwd, flags.get("registry") ?? "accounts.json")),
    );
    const file = resolve(cwd, `Pulumi.${stack.stackFile}.yaml`);
    if (write) {
      writeFileSync(file, renderStackYaml(stack));
    }
    return { code: 0, output: JSON.stringify({ ...stack, file: write ? file : null }) };
  } catch (error) {
    return { code: 1, output: error instanceof Error ? error.message : String(error) };
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const result = runCustomerCli(process.argv.slice(2));
  (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
}
