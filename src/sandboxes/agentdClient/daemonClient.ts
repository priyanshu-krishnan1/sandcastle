/**
 * Thin client wrapper around the generated agentd gRPC stubs — the daemon-side
 * analogue of fyre.ts's `remoteExec`/`copyFileToRemote`/`copyFileFromRemote`,
 * calling the persistent daemon connection instead of spawning `ssh`/`scp`.
 *
 * Every exported function here maps gRPC's structured `status.code`/
 * `status.details` into a plain `Error` (never the Effect-based
 * `Data.TaggedError` classes in `../../errors.js`), matching fyre.ts's own
 * error convention — required because this module is reachable from the
 * public `./sandboxes/remoteDaemon` export, which must stay Effect-free (see
 * scripts/check-public-types-effect-free.mjs).
 */

import {
  credentials,
  Client,
  status as GrpcStatus,
  type ChannelCredentials,
  type ClientReadableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type {
  ExecResult,
  InteractiveExecOptions,
} from "../../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../../utils/boundedTail.js";
import {
  AgentDaemonClient,
  type ExecEvent,
  type InteractiveExecServerMsg,
} from "./generated/agentd.js";

export interface DaemonTlsOptions {
  readonly clientCertFile: string;
  readonly clientKeyFile: string;
  readonly caCertFile: string;
  readonly serverName?: string;
}

export interface DaemonConnectOptions {
  readonly host: string;
  readonly port?: number;
  readonly tls: DaemonTlsOptions;
  readonly connectTimeoutMs?: number;
}

const DEFAULT_PORT = 8443;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** A connected daemon client plus the raw address, for error messages. */
export interface DaemonClient {
  readonly client: AgentDaemonClient;
  readonly address: string;
  close(): void;
}

const loadChannelCredentials = async (
  tls: DaemonTlsOptions,
): Promise<ChannelCredentials> => {
  const [ca, key, cert] = await Promise.all([
    readFile(tls.caCertFile),
    readFile(tls.clientKeyFile),
    readFile(tls.clientCertFile),
  ]);
  return credentials.createSsl(ca, key, cert);
};

/**
 * Opens one persistent channel to the daemon at `options.host:options.port`.
 * Held for the lifetime of a `SandboxHandle` (see remoteDaemon.ts) — every
 * `exec`/`interactiveExec`/`transfer` call for that sandbox reuses this one
 * connection instead of spawning a process per call.
 */
export const createDaemonClient = async (
  options: DaemonConnectOptions,
): Promise<DaemonClient> => {
  const port = options.port ?? DEFAULT_PORT;
  const address = `${options.host}:${port}`;
  const channelCreds = await loadChannelCredentials(options.tls);
  const client = new AgentDaemonClient(address, channelCreds, {
    "grpc.ssl_target_name_override": options.tls.serverName ?? options.host,
  });

  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const deadline = Date.now() + connectTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    client.waitForReady(deadline, (err) => {
      if (err) {
        client.close();
        reject(
          new Error(
            `daemon connect timed out after ${connectTimeoutMs}ms (host: ${address}): ${err.message}`,
          ),
        );
        return;
      }
      resolve();
    });
  });

  return {
    client,
    address,
    close: () => client.close(),
  };
};

/** Maps a gRPC ServiceError into a descriptive plain Error, per operation. */
const mapDaemonError = (
  operation: string,
  address: string,
  err: ServiceError,
): Error => {
  switch (err.code) {
    case GrpcStatus.UNAUTHENTICATED:
      return new Error(
        `daemon auth failed: ${err.details} (host: ${address}) — check client cert/CA configuration`,
      );
    case GrpcStatus.UNAVAILABLE:
      return new Error(
        `daemon unavailable during ${operation}: ${err.details} (host: ${address})`,
      );
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new Error(
        `daemon ${operation} timed out: ${err.details} (host: ${address})`,
      );
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return new Error(
        `daemon ${operation} rejected: max concurrent execs reached on ${address}`,
      );
    default:
      return new Error(`daemon ${operation} failed: ${err.details}`);
  }
};

export interface DaemonExecOptions {
  readonly onLine?: (line: string) => void;
  readonly cwd?: string;
  readonly sudo?: boolean;
  readonly stdin?: string;
  readonly env?: Record<string, string>;
}

/** The daemon-backed analogue of fyre.ts's `remoteExec`. */
export const daemonExec = async (
  daemon: DaemonClient,
  command: string,
  execOptions?: DaemonExecOptions,
  maxOutputTailChars: number = MAX_TAIL_CHARS,
): Promise<ExecResult> => {
  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
  const stderrTail = new BoundedTail(maxOutputTailChars, "");

  return new Promise<ExecResult>((resolve, reject) => {
    let stream: ClientReadableStream<ExecEvent>;
    try {
      stream = daemon.client.exec({
        execId: randomUUID(),
        command,
        cwd: execOptions?.cwd ?? "",
        sudo: execOptions?.sudo ?? false,
        env: execOptions?.env ?? {},
        stdin: execOptions?.stdin,
      });
    } catch (err) {
      reject(
        new Error(
          `daemon exec failed to start: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    let exitCode = 0;
    stream.on("data", (event: ExecEvent) => {
      if (event.stdoutLine) {
        stdoutTail.push(event.stdoutLine.line);
        execOptions?.onLine?.(event.stdoutLine.line);
      } else if (event.stderrLine) {
        stderrTail.push(event.stderrLine.line);
      } else if (event.exit) {
        exitCode = event.exit.exitCode;
      }
    });
    stream.on("error", (err: ServiceError) => {
      reject(mapDaemonError("exec", daemon.address, err));
    });
    stream.on("end", () => {
      resolve({
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        exitCode,
      });
    });
  });
};

/** The daemon-backed analogue of fyre.ts's interactiveExec ssh spawn. */
export const daemonInteractiveExec = async (
  daemon: DaemonClient,
  args: string[],
  execOptions: InteractiveExecOptions,
  env: Record<string, string>,
): Promise<{ exitCode: number }> => {
  return new Promise((resolve, reject) => {
    const call = daemon.client.interactiveExec();

    const isTTY = (execOptions.stdin as unknown as { isTTY?: boolean }).isTTY;
    call.write({
      start: {
        args,
        cwd: execOptions.cwd ?? "",
        env,
        sudo: false,
        pty: isTTY === true,
        initialSize:
          isTTY === true
            ? {
                cols: (process.stdout.columns ?? 80) >>> 0,
                rows: (process.stdout.rows ?? 24) >>> 0,
              }
            : undefined,
      },
    });

    const onStdinData = (chunk: Buffer) => call.write({ stdinChunk: chunk });
    const onStdinEnd = () => call.write({ closeStdin: true });
    execOptions.stdin.on("data", onStdinData);
    execOptions.stdin.on("end", onStdinEnd);

    const onResize = () => {
      call.write({
        resize: {
          cols: (process.stdout.columns ?? 80) >>> 0,
          rows: (process.stdout.rows ?? 24) >>> 0,
        },
      });
    };
    if (isTTY === true) {
      process.stdout.on("resize", onResize);
    }

    const cleanup = () => {
      execOptions.stdin.off("data", onStdinData);
      execOptions.stdin.off("end", onStdinEnd);
      if (isTTY === true) {
        process.stdout.off("resize", onResize);
      }
    };

    let exitCode = 0;
    call.on("data", (msg: InteractiveExecServerMsg) => {
      if (msg.stdoutChunk) {
        execOptions.stdout.write(msg.stdoutChunk);
      } else if (msg.stderrChunk) {
        execOptions.stderr.write(msg.stderrChunk);
      } else if (msg.exit) {
        exitCode = msg.exit.exitCode;
      }
    });
    call.on("error", (err: ServiceError) => {
      cleanup();
      reject(mapDaemonError("interactive exec", daemon.address, err));
    });
    call.on("end", () => {
      cleanup();
      resolve({ exitCode });
    });
  });
};

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
};

const writeTarArchive = async (
  sourcePath: string,
  outputPath: string,
): Promise<void> => {
  await mkdir(dirname(outputPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-czf", outputPath, "-C", sourcePath, "."], (error) => {
      if (error) {
        reject(new Error(`tar archive creation failed: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
};

/** Uploads a chunk of `filePath` into the sandbox at `sandboxPath` via CopyIn. */
const copyFileIn = async (
  daemon: DaemonClient,
  filePath: string,
  sandboxPath: string,
  isDirectory: boolean,
): Promise<void> => {
  const [sha256, info] = await Promise.all([
    sha256File(filePath),
    stat(filePath),
  ]);

  await new Promise<void>((resolve, reject) => {
    const call = daemon.client.copyIn((err, result) => {
      if (err) {
        reject(mapDaemonError("copy in", daemon.address, err));
        return;
      }
      if (!result.ok) {
        reject(new Error(`daemon copy in failed: ${result.error}`));
        return;
      }
      resolve();
    });

    call.write({
      header: { sandboxPath, isDirectory, sha256, size: info.size },
    });

    const readStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    readStream.on("data", (chunk) => {
      call.write({ data: chunk as Buffer });
    });
    readStream.on("end", () => call.end());
    readStream.on("error", (err) => {
      call.cancel();
      reject(err);
    });
  });
};

/** The daemon-backed analogue of fyre.ts's `copyInRecursive`. */
export const daemonCopyIn = async (
  daemon: DaemonClient,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const info = await stat(hostPath);
  if (!info.isDirectory()) {
    await copyFileIn(daemon, hostPath, sandboxPath, false);
    return;
  }

  const archivePath = join(
    tmpdir(),
    `sandcastle-remote-daemon-${randomUUID()}.tar.gz`,
  );
  await writeTarArchive(hostPath, archivePath);
  try {
    await copyFileIn(daemon, archivePath, sandboxPath, true);
  } finally {
    await rm(archivePath, { force: true });
  }
};

/** The daemon-backed analogue of fyre.ts's `copyFileFromRemote`. */
export const daemonCopyOut = async (
  daemon: DaemonClient,
  sandboxPath: string,
  hostPath: string,
): Promise<void> => {
  await mkdir(dirname(hostPath), { recursive: true });
  const tmpPath = `${hostPath}.agentd-download-${randomUUID()}`;

  await new Promise<void>((resolve, reject) => {
    const stream = daemon.client.copyOut({ sandboxPath });
    const hash = createHash("sha256");
    const out = createWriteStream(tmpPath);
    let trailerSha256: string | undefined;

    stream.on("data", (chunk: import("./generated/agentd.js").CopyOutChunk) => {
      if (chunk.data) {
        hash.update(chunk.data);
        out.write(chunk.data);
      } else if (chunk.trailer) {
        trailerSha256 = chunk.trailer.sha256;
      }
    });
    stream.on("error", (err: ServiceError) => {
      out.close();
      reject(mapDaemonError("copy out", daemon.address, err));
    });
    stream.on("end", () => {
      out.end(async () => {
        const got = hash.digest("hex");
        if (trailerSha256 !== undefined && got !== trailerSha256) {
          await rm(tmpPath, { force: true });
          reject(
            new Error(
              `daemon copy out failed: checksum mismatch (want ${trailerSha256}, got ${got})`,
            ),
          );
          return;
        }
        await rename(tmpPath, hostPath);
        resolve();
      });
    });
  });
};
