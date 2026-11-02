import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/azure-estate/*.test.mjs"],
  },
});
