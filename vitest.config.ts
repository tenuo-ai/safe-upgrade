import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    // Tenuo refuses createTenuo.devRoot() unless NODE_ENV is development or test.
    env: { NODE_ENV: "test" },
    testTimeout: 30_000,
  },
});
