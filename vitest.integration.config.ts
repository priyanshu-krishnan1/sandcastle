import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts's default `npm test` tier deliberately:
// these tests spawn the real `agentd` Go binary and drive it over a real
// mTLS gRPC connection, so they need a Go toolchain + openssl on PATH.
// `npm test` must stay fast and toolchain-independent for ordinary
// contributors — see agentd/README.md and
// docs/adr/0024-daemon-transport-for-fyre.md's Phase 4/5 build order.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["src/utils/testSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
