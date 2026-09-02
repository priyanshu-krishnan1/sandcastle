/**
 * Fyre sandbox providers — execute sandbox commands on a remote host over SSH.
 *
 * Two modes:
 *
 * fyre({ host }) — isolated provider (tag: "isolated").
 *   Sandcastle bundles the local repo, SCPs it to the remote host, and clones it
 *   into a fresh temp directory. The remote workspace is deleted on close().
 *   Use this when you want a clean, throwaway copy of your repo on each run.
 *
 *   import { fyre } from "sandcastle/sandboxes/fyre";
 *   await run({ agent: bob("default"), sandbox: fyre({ host: "fyre-x86" }) });
 *
 * fyreNative({ host, repoPath }) — native provider (tag: "none").
 *   No files are transferred. The agent runs directly inside a pre-existing
 *   repository on the remote host. Nothing is cleaned up on close().
 *   Use this when the repo already lives on the remote machine.
 *
 *   import { fyreNative } from "sandcastle/sandboxes/fyre";
 *   await run({ agent: bob("default"), sandbox: fyreNative({ host: "fyre-x86", repoPath: "/home/user/my-repo" }) });
 */

import { execFile, spawn, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
  type IsolatedCreateOptions,
  type IsolatedSandboxProvider,
  type NoSandboxProvider,
  type SandboxHandle,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { shellQuote } from "../shellQuote.js";

export interface FyreOptions {
  /** SSH host alias or hostname. */
  readonly host: string;
  /** SSH username. */
  readonly user?: string;
  /** Path to the SSH identity file. */
  readonly identityFile?: string;
  /** Additional arguments passed to the ssh command. */
  readonly sshArgs?: readonly string[];
  /** Additional arguments passed to the scp command. */
  readonly scpArgs?: readonly string[];
  /** Base directory on the remote host for Sandcastle temp state. */
  readonly remoteRoot?: string;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   */
  readonly maxOutputTailChars?: number;
}

const buildSshTarget = (options: FyreOptions): string =>
  options.user ? `${options.user}@${options.host}` : options.host;

const buildSshBaseArgs = (options: FyreOptions): string[] => {
  const args = ["-o", "BatchMode=yes"];
  if (options.identityFile) {
    args.push("-i", options.identityFile);
  }
  if (options.sshArgs) {
    args.push(...options.sshArgs);
  }
  args.push(buildSshTarget(options));
  return args;
};

const buildScpBaseArgs = (options: FyreOptions): string[] => {
  const args = ["-o", "BatchMode=yes"];
  if (options.identityFile) {
    args.push("-i", options.identityFile);
  }
  if (options.scpArgs) {
    args.push(...options.scpArgs);
  }
  return args;
};

/**
 * Serialize an env dict to a shell prefix: `KEY='value' KEY2='value2' `.
 * Each value is single-quote escaped so it is safe to inject into a `sh -c` string.
 */
const buildEnvPrefix = (env: Record<string, string>): string => {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ") + " ";
};

const remoteExec = async (
  options: FyreOptions,
  command: string,
  execOptions?: {
    onLine?: (line: string) => void;
    cwd?: string;
    sudo?: boolean;
    stdin?: string;
    /** Extra env vars forwarded into the remote shell for this invocation. */
    env?: Record<string, string>;
  },
): Promise<ExecResult> => {
  const sshArgs = [...buildSshBaseArgs(options)];
  const envPrefix = buildEnvPrefix(execOptions?.env ?? {});
  const sudoPrefix = execOptions?.sudo ? "sudo " : "";
  const remoteCommand = execOptions?.cwd
    ? `cd ${shellQuote(execOptions.cwd)} && ${envPrefix}${sudoPrefix}${command}`
    : `${envPrefix}${sudoPrefix}${command}`;
  // Pass remoteCommand as a single string argument — SSH invokes the user's
  // shell on the remote side to interpret it (equivalent to `ssh host 'cmd'`).
  // Do NOT split into ["sh", "-c", remoteCommand] — that would pass the command
  // as separate argv entries and `sh -c` would only treat the first word as the
  // command, discarding all flags.
  sshArgs.push(remoteCommand);

  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", sshArgs, {
      stdio: [
        execOptions?.stdin !== undefined ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
    });

    if (execOptions?.stdin !== undefined) {
      proc.stdin!.write(execOptions.stdin);
      proc.stdin!.end();
    }

    proc.on("error", (error) => {
      reject(new Error(`ssh exec failed: ${error.message}`));
    });

    if (execOptions?.onLine) {
      const stdoutTail = new BoundedTail(
        options.maxOutputTailChars ?? MAX_TAIL_CHARS,
        "\n",
      );
      const stderrTail = new BoundedTail(
        options.maxOutputTailChars ?? MAX_TAIL_CHARS,
        "",
      );
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutTail.push(line);
        execOptions.onLine!(line);
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk.toString());
      });
      proc.on("close", (code) => {
        resolve({
          stdout: stdoutTail.toString(),
          stderr: stderrTail.toString(),
          exitCode: code ?? 0,
        });
      });
      return;
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
    proc.on("close", (code) => {
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });
  });
};

const copyFileToRemote = async (
  options: FyreOptions,
  hostPath: string,
  remotePath: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "scp",
      [
        ...buildScpBaseArgs(options),
        hostPath,
        `${buildSshTarget(options)}:${remotePath}`,
      ],
      (error) => {
        if (error) {
          reject(new Error(`scp copy to remote failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
};

const copyFileFromRemote = async (
  options: FyreOptions,
  remotePath: string,
  hostPath: string,
): Promise<void> => {
  await mkdir(dirname(hostPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(
      "scp",
      [
        ...buildScpBaseArgs(options),
        `${buildSshTarget(options)}:${remotePath}`,
        hostPath,
      ],
      (error) => {
        if (error) {
          reject(new Error(`scp copy from remote failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
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

const copyDirectoryToRemote = async (
  options: FyreOptions,
  hostPath: string,
  remotePath: string,
): Promise<void> => {
  const archivePath = join(tmpdir(), `sandcastle-fyre-${randomUUID()}.tar.gz`);
  await writeTarArchive(hostPath, archivePath);
  try {
    const remoteArchive = `${remotePath}.tar.gz`;
    await remoteExec(
      options,
      `mkdir -p ${shellQuote(posix.dirname(remotePath))}`,
    );
    await copyFileToRemote(options, archivePath, remoteArchive);
    await remoteExec(
      options,
      `mkdir -p ${shellQuote(remotePath)} && tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remotePath)} && rm -f ${shellQuote(remoteArchive)}`,
    );
  } finally {
    await rm(archivePath, { force: true });
  }
};

const ensureRemoteDir = async (
  options: FyreOptions,
  remotePath: string,
): Promise<void> => {
  await remoteExec(options, `mkdir -p ${shellQuote(remotePath)}`);
};

const copyInRecursive = async (
  options: FyreOptions,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const info = await stat(hostPath);
  if (info.isDirectory()) {
    await copyDirectoryToRemote(options, hostPath, sandboxPath);
    return;
  }
  await ensureRemoteDir(options, posix.dirname(sandboxPath));
  await copyFileToRemote(options, hostPath, sandboxPath);
};

export const fyre = (options: FyreOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "fyre",
    env: options.env,
    create: async (
      createOptions: IsolatedCreateOptions,
    ): Promise<SandboxHandle> => {
      // createOptions.env is the fully-merged env dict from:
      //   .sandcastle/.env  +  process.env  +  bob({ env:{} })  +  fyre({ env:{} })
      // We forward it into every remote command so the agent has its credentials.
      const sessionEnv = createOptions.env;

      const remoteRoot =
        options.remoteRoot ?? `/tmp/sandcastle-${randomUUID()}`;
      const worktreePath = posix.join(remoteRoot, "workspace");
      await remoteExec(
        options,
        `mkdir -p ${shellQuote(remoteRoot)} ${shellQuote(worktreePath)}`,
      );

      return {
        worktreePath,
        exec: (command, execOptions) =>
          remoteExec(options, command, { ...execOptions, env: sessionEnv }),
        interactiveExec: (args, execOptions) => {
          return new Promise((resolve, reject) => {
            const sshArgs = [...buildSshBaseArgs(options)];
            // Forward env vars via `ssh -o SendEnv` is unreliable (requires
            // AcceptEnv on the server). Instead prepend them into the remote
            // shell command so they are always available regardless of sshd config.
            const envPrefix = buildEnvPrefix(sessionEnv);
            const argsPart = args.map(shellQuote).join(" ");
            const remoteCommand = execOptions.cwd
              ? `cd ${shellQuote(execOptions.cwd)} && ${envPrefix}exec ${argsPart}`
              : `${envPrefix}exec ${argsPart}`;
            sshArgs.push("sh", "-lc", remoteCommand);

            const proc = spawn("ssh", sshArgs, {
              stdio: [
                execOptions.stdin,
                execOptions.stdout,
                execOptions.stderr,
              ] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(
                new Error(`ssh interactive exec failed: ${error.message}`),
              );
            });
            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },
        transfer: {
          copyIn: (hostPath, sandboxPath) =>
            copyInRecursive(options, hostPath, sandboxPath),
          copyFileOut: async (sandboxPath, hostPath) => {
            await copyFileFromRemote(options, sandboxPath, hostPath);
          },
        },
        close: async () => {
          await remoteExec(options, `rm -rf ${shellQuote(remoteRoot)}`);
        },
      };
    },
  });

export type { IsolatedSandboxProvider };

// ---------------------------------------------------------------------------
// fyreNative — run the agent on a pre-existing remote repo (no sync)
// ---------------------------------------------------------------------------

export interface FyreNativeOptions {
  /** SSH host alias or hostname. */
  readonly host: string;
  /**
   * Absolute path to the pre-existing repository on the remote host.
   * The agent runs directly inside this directory — nothing is copied
   * from the local machine and nothing is deleted on close().
   */
  readonly repoPath: string;
  /** SSH username. */
  readonly user?: string;
  /** Path to the SSH identity file. */
  readonly identityFile?: string;
  /** Additional arguments passed to the ssh command. */
  readonly sshArgs?: readonly string[];
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   */
  readonly maxOutputTailChars?: number;
  /**
   * Shell used to execute commands on the remote host (default: `"bash"`).
   * Fyre machines use ksh as the login shell, which does not support `local`
   * and is incompatible with nvm and bob. Set to `"bash"` (the default) to
   * ensure bash is used regardless of the user's login shell.
   */
  readonly shell?: string;
}

/**
 * Fyre native provider — runs the agent directly on a remote Fyre host over SSH
 * against a pre-existing repository. No repo sync or cleanup is performed.
 *
 * Because this provider has tag `"none"`, Sandcastle skips sync-in entirely.
 * The agent executes inside `repoPath` on the remote host using the branch
 * strategy of your choice (merge-to-head, branch, or head) — `nativeGitTarget`
 * (set below) tells SandboxLifecycle.ts to run those branch-strategy/merge/
 * diff-collection git operations through this handle's own SSH exec against
 * `repoPath`, instead of against the local host's git, which has no relation
 * to where the agent actually worked.
 *
 * @example
 * ```typescript
 * import { run, bob } from "@ai-hero/sandcastle";
 * import { fyreNative } from "@ai-hero/sandcastle/sandboxes/fyre";
 *
 * await run({
 *   agent: bob("default"),
 *   sandbox: fyreNative({ host: "fyre-machine-1", repoPath: "/home/user/my-repo" }),
 *   prompt: "Fix the failing tests",
 * });
 * ```
 */
export const fyreNative = (options: FyreNativeOptions): NoSandboxProvider => ({
  tag: "none",
  name: "fyre-native",
  env: options.env ?? {},
  // repoPath lives on the remote host, not under the local hostRepoDir —
  // branch-strategy/merge/diff-collection must run via this handle's own
  // SSH exec against repoPath, not the local host's git. See
  // NoSandboxProvider.nativeGitTarget.
  nativeGitTarget: true,

  create: async (createOptions): Promise<SandboxHandle> => {
    // Ignore the framework-supplied worktreePath (local temp dir) and use the
    // pre-existing remote path so all exec() calls land in the right place.
    const worktreePath = options.repoPath;
    const sessionEnv = createOptions.env;
    const maxOutputTailChars = options.maxOutputTailChars ?? MAX_TAIL_CHARS;
    // Default to bash — Fyre machines use ksh which is incompatible with nvm/bob.
    const shell = options.shell ?? "bash";

    // Serialize env vars as `export KEY='val'` statements separated by `;`.
    // Unlike the plain `KEY='val' cmd` prefix form used by remoteExec (which
    // only sets vars for a single command), exported vars are inherited by
    // every child process in the chain — including `bob run`.
    const buildExportStatements = (env: Record<string, string>): string => {
      const entries = Object.entries(env);
      if (entries.length === 0) return "";
      return (
        entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("; ") +
        "; "
      );
    };

    // Build a remote command string wrapped in the chosen shell so it runs
    // under bash regardless of the user's login shell.
    const buildNativeRemoteCommand = (
      command: string,
      execOptions?: {
        cwd?: string;
        sudo?: boolean;
        env?: Record<string, string>;
      },
    ): string => {
      const exports = buildExportStatements({
        ...sessionEnv,
        ...(execOptions?.env ?? {}),
      });
      const sudoPrefix = execOptions?.sudo ? "sudo " : "";
      const cwd = execOptions?.cwd ?? worktreePath;
      const inner = `cd ${shellQuote(cwd)}; ${exports}${sudoPrefix}${command}`;
      return `${shell} -c ${shellQuote(inner)}`;
    };

    return {
      worktreePath,

      exec: (command, execOptions): Promise<ExecResult> => {
        const sshArgs = [...buildSshBaseArgs(options)];
        sshArgs.push(buildNativeRemoteCommand(command, execOptions));

        return new Promise((resolve, reject) => {
          const proc = spawn("ssh", sshArgs, {
            stdio: [
              execOptions?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
          });

          if (execOptions?.stdin !== undefined) {
            proc.stdin!.write(execOptions.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            reject(new Error(`ssh exec failed: ${error.message}`));
          });

          if (execOptions?.onLine) {
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutTail.push(line);
              execOptions.onLine!(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutTail.toString(),
                stderr: stderrTail.toString(),
                exitCode: code ?? 0,
              });
            });
            return;
          }

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          proc.stdout!.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });
          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });
          proc.on("close", (code) => {
            resolve({
              stdout: stdoutChunks.join(""),
              stderr: stderrChunks.join(""),
              exitCode: code ?? 0,
            });
          });
        });
      },

      interactiveExec: (args, execOptions): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const sshArgs = [...buildSshBaseArgs(options)];
          const exports = buildExportStatements(sessionEnv);
          const cwd = execOptions.cwd ?? worktreePath;
          const argsPart = args.map(shellQuote).join(" ");
          const inner = `cd ${shellQuote(cwd)}; ${exports}exec ${argsPart}`;
          sshArgs.push(shell, "-c", shellQuote(inner));

          const proc = spawn("ssh", sshArgs, {
            stdio: [
              execOptions.stdin,
              execOptions.stdout,
              execOptions.stderr,
            ] as StdioOptions,
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`ssh interactive exec failed: ${error.message}`));
          });
          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        // No-op — the repo is pre-existing; nothing to tear down.
      },
    };
  },
});

export type { NoSandboxProvider };
