import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { FARSIDE_LOG_LEVEL: "silent" },
    include: ["src/**/*.test.ts"],
  },
});
