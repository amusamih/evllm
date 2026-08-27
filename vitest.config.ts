import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/setup/prepare-production-contract-artifacts.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
