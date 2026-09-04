import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remoteDaemon, remoteDaemonNative } from "./remoteDaemon.js";
import {
  startAgentd,
  toolchainAvailable,
  type AgentdTestInstance,
} from "./agentdClient/testHarness.js";

// End-to-end tests against a real `agentd` binary (via `go run`) and a real
// mTLS gRPC connection — the actual proof that the TS client and Go daemon
// speak the same wire protocol correctly, not just that types line up. See
// vitest.integration.config.ts and docs/adr/0024-daemon-transport-for-fyre.md.
//
// Skipped entirely (not failed) when `go`/`openssl` aren't on PATH, so this
// file can be included in `npm run test:integration` without every
// environment needing the Go toolchain.
const hasToolchain = await toolchainAvailable();

describe.skipIf(!hasToolchain)("remoteDaemon() against a real agentd", () => {
  let agentd: AgentdTestInstance;

  beforeAll(async () => {
    agentd = await startAgentd();
  }, 30_000);

  afterAll(async () => {
    await agentd?.stop();
  });

  it("exec streams output line-by-line and reports the real exit code", async () => {
    const provider = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const handle = await provider.create({ env: {} });
    try {
      const lines: string[] = [];
      const result = await handle.exec(
        `echo one; echo two; echo err >&2; exit 3`,
        { onLine: (line) => lines.push(line) },
      );
      expect(lines).toEqual(["one", "two"]);
      expect(result.stdout).toBe("one\ntwo");
      expect(result.stderr).toContain("err");
      expect(result.exitCode).toBe(3);
    } finally {
      await handle.close();
    }
  });

  it("pipes stdin through to the command and closes it", async () => {
    const provider = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const handle = await provider.create({ env: {} });
    try {
      const result = await handle.exec("cat", { stdin: "hello daemon" });
      expect(result.stdout).toBe("hello daemon");
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("delivers lines with real latency, not batched at the end", async () => {
    const provider = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const handle = await provider.create({ env: {} });
    try {
      const arrivals: number[] = [];
      const start = Date.now();
      await handle.exec(`echo a; sleep 0.3; echo b; sleep 0.3; echo c`, {
        onLine: () => arrivals.push(Date.now() - start),
      });
      expect(arrivals).toHaveLength(3);
      const [first, , last] = arrivals;
      // The third line should not arrive within the same instant as the
      // first — if it did, output was buffered rather than streamed live.
      expect(last! - first!).toBeGreaterThan(400);
    } finally {
      await handle.close();
    }
  });

  it("transfer.copyIn then copyFileOut round-trips a file through the sandbox", async () => {
    const provider = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const handle = await provider.create({ env: {} });
    const localDir = await mkdtemp(join(tmpdir(), "remote-daemon-it-"));
    try {
      const srcPath = join(localDir, "payload.txt");
      const content = "round trip me\n".repeat(5000); // larger than one chunk
      await writeFile(srcPath, content);

      const sandboxPath = `${handle.worktreePath}/uploaded.txt`;
      await handle.transfer!.copyIn(srcPath, sandboxPath);

      const catResult = await handle.exec(`wc -c < ${sandboxPath}`);
      expect(catResult.stdout.trim()).toBe(String(content.length));

      const downloadPath = join(localDir, "downloaded.txt");
      await handle.transfer!.copyFileOut(sandboxPath, downloadPath);
      const downloaded = await readFile(downloadPath, "utf8");
      expect(downloaded).toBe(content);
    } finally {
      await handle.close();
      await rm(localDir, { recursive: true, force: true });
    }
  });

  it("close() removes the remote workspace", async () => {
    const provider = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const handle = await provider.create({ env: {} });
    const worktreePath = handle.worktreePath;
    await handle.close();

    // A fresh handle is used only to check the old path is gone — the
    // daemon connection itself doesn't retain any state tied to the closed
    // handle.
    const checker = remoteDaemon({
      host: "127.0.0.1",
      port: agentd.port,
      tls: agentd.tls,
    });
    const checkHandle = await checker.create({ env: {} });
    try {
      const result = await checkHandle.exec(
        `test -d ${worktreePath} && echo exists || echo gone`,
      );
      expect(result.stdout.trim()).toBe("gone");
    } finally {
      await checkHandle.close();
    }
  });
});

describe.skipIf(!hasToolchain)(
  "remoteDaemonNative() against a real agentd",
  () => {
    let agentd: AgentdTestInstance;
    let repoDir: string;

    beforeAll(async () => {
      agentd = await startAgentd();
      repoDir = await mkdtemp(join(tmpdir(), "remote-daemon-native-it-"));
      await writeFile(join(repoDir, "marker.txt"), "pre-existing repo\n");
    }, 30_000);

    afterAll(async () => {
      await agentd?.stop();
      await rm(repoDir, { recursive: true, force: true });
    });

    it("runs commands directly against the pre-existing repoPath", async () => {
      const provider = remoteDaemonNative({
        host: "127.0.0.1",
        port: agentd.port,
        tls: agentd.tls,
        repoPath: repoDir,
      });
      expect(provider.nativeGitTarget).toBe(true);

      const handle = await provider.create({
        worktreePath: "/ignored/framework/temp/dir",
        env: {},
      });
      try {
        expect(handle.worktreePath).toBe(repoDir);
        const result = await handle.exec("cat marker.txt");
        expect(result.stdout.trim()).toBe("pre-existing repo");
        expect(result.exitCode).toBe(0);
      } finally {
        await handle.close();
      }
    });

    it("close() does not delete the pre-existing repo", async () => {
      const provider = remoteDaemonNative({
        host: "127.0.0.1",
        port: agentd.port,
        tls: agentd.tls,
        repoPath: repoDir,
      });
      const handle = await provider.create({
        worktreePath: "/ignored",
        env: {},
      });
      await handle.close();

      const stillThere = await readFile(join(repoDir, "marker.txt"), "utf8");
      expect(stillThere).toBe("pre-existing repo\n");
    });
  },
);
