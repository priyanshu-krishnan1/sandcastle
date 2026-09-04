/**
 * Test-only helper that boots a real `agentd` binary (via `go run`) with
 * throwaway mTLS certs, for the *.integration.test.ts tier — see
 * vitest.integration.config.ts and agentd/README.md. Not part of the public
 * package surface; imported only from integration test files.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import type { DaemonTlsOptions } from "./daemonClient.js";

const AGENTD_DIR = new URL("../../../agentd/", import.meta.url).pathname;

const execFileAsync = (
  cmd: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, options ?? {}, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed: ${stderr || error.message}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/** Finds a free TCP port by briefly binding to port 0. */
const findFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
};

const waitForPortOpen = async (
  port: number,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const conn = connect({ host: "127.0.0.1", port }, () => {
        conn.destroy();
        resolve(true);
      });
      conn.on("error", () => resolve(false));
    });
    if (opened) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agentd did not open port ${port} within ${timeoutMs}ms`);
};

export interface AgentdTestInstance {
  readonly port: number;
  readonly tls: DaemonTlsOptions;
  stop(): Promise<void>;
}

/**
 * Returns null (instead of throwing) when `go` or `openssl` isn't on PATH —
 * callers use this to skip the integration suite rather than fail it in
 * environments without the Go toolchain.
 */
export const toolchainAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync("go", ["version"]);
    await execFileAsync("openssl", ["version"]);
    return true;
  } catch {
    return false;
  }
};

/** Boots a real agentd instance with throwaway certs. Caller must call stop(). */
export const startAgentd = async (): Promise<AgentdTestInstance> => {
  const certDir = await mkdtemp(join(tmpdir(), "agentd-it-certs-"));
  await execFileAsync(join(AGENTD_DIR, "scripts", "gen-dev-ca.sh"), [certDir]);

  const tls: DaemonTlsOptions = {
    clientCertFile: join(certDir, "client-cert.pem"),
    clientKeyFile: join(certDir, "client-key.pem"),
    caCertFile: join(certDir, "ca-cert.pem"),
    // gen-dev-ca.sh always issues the server cert for CN=localhost — tests
    // connect via the 127.0.0.1 literal, so this override is required (SNI
    // on a raw IP is deprecated and gRPC would otherwise use `host` as-is).
    serverName: "localhost",
  };

  const port = await findFreePort();
  const proc: ChildProcess = spawn(
    "go",
    [
      "run",
      "./cmd/agentd",
      "-listen",
      `127.0.0.1:${port}`,
      "-server-cert",
      join(certDir, "server-cert.pem"),
      "-server-key",
      join(certDir, "server-key.pem"),
      "-client-ca",
      join(certDir, "ca-cert.pem"),
    ],
    { cwd: AGENTD_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderrOutput = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString();
  });

  const exitedEarly = new Promise<never>((_, reject) => {
    proc.on("exit", (code) => {
      reject(
        new Error(
          `agentd exited early (code ${code}) before becoming ready:\n${stderrOutput}`,
        ),
      );
    });
  });

  await Promise.race([waitForPortOpen(port, 20_000), exitedEarly]);

  return {
    port,
    tls,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
      await rm(certDir, { recursive: true, force: true });
    },
  };
};
