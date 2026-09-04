import { describe, expect, it } from "vitest";
import { fyre, fyreNative } from "./fyre.js";

describe("fyre()", () => {
  it("returns an isolated sandbox provider with name 'fyre'", () => {
    const provider = fyre({ host: "fyre-x86" });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("fyre");
  });

  it("defaults env to empty object when not provided", () => {
    const provider = fyre({ host: "fyre-x86" });
    expect(provider.env).toEqual({});
  });

  it("accepts provider env", () => {
    const provider = fyre({
      host: "fyre-x86",
      env: { FYRE_TEST: "1" },
    });
    expect(provider.env).toEqual({ FYRE_TEST: "1" });
  });

  it("allows ssh identity and user configuration", () => {
    const provider = fyre({
      host: "fyre-x86",
      user: "mohit29",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(provider.tag).toBe("isolated");
  });
});

describe("fyreNative()", () => {
  it("returns a no-sandbox provider tagged nativeGitTarget", () => {
    const provider = fyreNative({
      host: "fyre-x86",
      repoPath: "/home/user/my-repo",
    });
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("fyre-native");
    // Its repo lives on the remote host, not under the local hostRepoDir —
    // SandboxLifecycle.ts must route git operations through this handle's
    // own exec (see SandboxLifecycle.test.ts's nativeGitTarget suite),
    // rather than the local host's git, which has no relation to repoPath.
    expect(provider.nativeGitTarget).toBe(true);
  });

  it("create()'s handle reports repoPath as worktreePath, ignoring the framework-supplied one", async () => {
    const provider = fyreNative({
      host: "fyre-x86",
      repoPath: "/home/user/my-repo",
    });
    const handle = await provider.create({
      worktreePath: "/some/local/temp/dir",
      env: {},
    });
    expect(handle.worktreePath).toBe("/home/user/my-repo");
  });
});
