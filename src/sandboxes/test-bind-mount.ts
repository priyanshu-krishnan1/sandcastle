/**
 * Filesystem-based test bind-mount sandbox provider.
 *
 * Uses a temp directory on the local filesystem as the "sandbox".
 * Intended for testing the bind-mount provider abstraction without
 * requiring Docker or Podman.
 */

import {
  createBindMountSandboxProvider,
  type SandboxHandle,
  type BindMountSandboxProvider,
} from "../SandboxProvider.js";
import { createTempSandbox } from "./test-shared.js";

/**
 * Create a filesystem-based test bind-mount sandbox provider.
 *
 * The "sandbox" is a temp directory. `exec` runs shell commands in it, and
 * `close` removes the temp dir. No `transfer` capability — bind-mount
 * providers share the host filesystem via mount, so Sandcastle never calls
 * it (see `SandboxHandle.transfer`'s doc comment).
 */
export const testBindMount = (): BindMountSandboxProvider =>
  createBindMountSandboxProvider({
    name: "test-bind-mount",
    create: async (): Promise<SandboxHandle> => {
      const temp = await createTempSandbox("sandcastle-test-bm-");

      return {
        worktreePath: temp.worktreePath,
        exec: temp.exec,
        close: temp.close,
      };
    },
  });
