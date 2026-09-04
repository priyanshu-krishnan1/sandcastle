import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // *.integration.test.ts (agentd end-to-end tests) has its own config —
    // see vitest.integration.config.ts — since it needs a Go toolchain +
    // openssl on PATH and `npm test` must stay fast/toolchain-independent.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    setupFiles: ["src/utils/testSetup.ts"],
  },
});
