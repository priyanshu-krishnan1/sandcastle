import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testBindMount } from "./test-bind-mount.js";

describe("testBindMount()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'test-bind-mount'", () => {
    const provider = testBindMount();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("test-bind-mount");
  });

  it("can create a sandbox and exec a command", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      const result = await handle.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("exec runs in worktreePath by default", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      const result = await handle.exec("pwd");
      expect(result.stdout.trim()).toBe(handle.worktreePath);
    } finally {
      await handle.close();
    }
  });

  it("close cleans up the temp directory", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    const worktreePath = handle.worktreePath;
    expect(existsSync(worktreePath)).toBe(true);

    await handle.close();
    expect(existsSync(worktreePath)).toBe(false);
  });
});
