import { describe, expect, it } from "vitest";
import { remoteDaemon, remoteDaemonNative } from "./remoteDaemon.js";

const tls = {
  clientCertFile: "/tmp/client-cert.pem",
  clientKeyFile: "/tmp/client-key.pem",
  caCertFile: "/tmp/ca-cert.pem",
};

// These are fast, network-free shape/construction checks only — mirroring
// fyre.test.ts's suite for fyre()/fyreNative(). Anything that actually opens
// a connection (create()'s daemon handshake) belongs in the integration
// tier, which spawns a real agentd binary — see agentd/README.md and the
// daemon-transport plan's Phase 4/5.
describe("remoteDaemon()", () => {
  it("returns an isolated sandbox provider with name 'remote-daemon'", () => {
    const provider = remoteDaemon({ host: "remote-host-1", tls });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("remote-daemon");
  });

  it("defaults env to empty object when not provided", () => {
    const provider = remoteDaemon({ host: "remote-host-1", tls });
    expect(provider.env).toEqual({});
  });

  it("accepts provider env", () => {
    const provider = remoteDaemon({
      host: "remote-host-1",
      tls,
      env: { REMOTE_TEST: "1" },
    });
    expect(provider.env).toEqual({ REMOTE_TEST: "1" });
  });

  it("allows port and connect-timeout configuration", () => {
    const provider = remoteDaemon({
      host: "remote-host-1",
      tls,
      port: 9443,
      connectTimeoutMs: 2000,
    });
    expect(provider.tag).toBe("isolated");
  });
});

describe("remoteDaemonNative()", () => {
  it("returns a no-sandbox provider tagged nativeGitTarget", () => {
    const provider = remoteDaemonNative({
      host: "remote-host-1",
      tls,
      repoPath: "/home/user/my-repo",
    });
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("remote-daemon-native");
    // Its repo lives on the remote host, not under the local hostRepoDir —
    // SandboxLifecycle.ts must route git operations through this handle's
    // own exec (the same nativeGitTarget mechanism fyreNative() uses),
    // rather than the local host's git, which has no relation to repoPath.
    expect(provider.nativeGitTarget).toBe(true);
  });

  it("defaults env to empty object when not provided", () => {
    const provider = remoteDaemonNative({
      host: "remote-host-1",
      tls,
      repoPath: "/home/user/my-repo",
    });
    expect(provider.env).toEqual({});
  });
});
