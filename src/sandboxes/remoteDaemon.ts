/**
 * Remote daemon sandbox providers — execute sandbox commands over a
 * persistent, multiplexed gRPC connection to `agentd` (see `agentd/` at the
 * repo root and docs/adr/0024-daemon-transport-for-fyre.md) instead of
 * spawning a fresh `ssh` process per command like `fyre()`/`fyreNative()` in
 * `./fyre.js` do.
 *
 * Nothing here is specific to Fyre — `agentd` and these providers work
 * against any remote Linux host you've deployed the daemon binary and an
 * mTLS certificate to. Fyre VMs are simply the motivating and
 * currently-deployed target (see ADR-0024's addendum); use `fyre.ts`'s
 * SSH-based providers instead if you don't have (or don't want to run)
 * `agentd` on the remote host.
 *
 * Two modes, mirroring `fyre()`/`fyreNative()` exactly:
 *
 * remoteDaemon({ host, tls }) — isolated provider (tag: "isolated").
 *   Sandcastle bundles the local repo and uploads it to the remote host via
 *   CopyIn, into a fresh temp directory. The remote workspace is deleted on
 *   close().
 *
 *   import { remoteDaemon } from "sandcastle/sandboxes/remoteDaemon";
 *   await run({ agent: bob("default"), sandbox: remoteDaemon({ host: "fyre-x86", tls: {...} }) });
 *
 * remoteDaemonNative({ host, tls, repoPath }) — native provider (tag: "none").
 *   No files are transferred. The agent runs directly inside a pre-existing
 *   repository on the remote host. Nothing is cleaned up on close().
 *
 *   import { remoteDaemonNative } from "sandcastle/sandboxes/remoteDaemon";
 *   await run({ agent: bob("default"), sandbox: remoteDaemonNative({ host: "fyre-x86", tls: {...}, repoPath: "/home/user/my-repo" }) });
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedCreateOptions,
  type IsolatedSandboxProvider,
  type NoSandboxProvider,
  type SandboxHandle,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../utils/boundedTail.js";
import { shellQuote } from "../utils/shellQuote.js";
import {
  createDaemonClient,
  daemonCopyIn,
  daemonCopyOut,
  daemonExec,
  daemonInteractiveExec,
  type DaemonClient,
  type DaemonTlsOptions,
} from "./agentdClient/daemonClient.js";

export interface RemoteDaemonOptions {
  /** Daemon hostname or IP — the same host `fyre()` SSHes to; `agentd` runs on its own port. */
  readonly host: string;
  /** agentd's listen port. Default: 8443. */
  readonly port?: number;
  /** mTLS material. All three files are required — the daemon rejects unauthenticated connections. */
  readonly tls: DaemonTlsOptions;
  /** Base directory on the remote host for Sandcastle temp state. */
  readonly remoteRoot?: string;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   */
  readonly maxOutputTailChars?: number;
  /** Fail fast if the daemon channel can't be established within this many ms (default: 5000). */
  readonly connectTimeoutMs?: number;
}

/**
 * Remote daemon provider — runs the agent against a fresh copy of the repo
 * uploaded to the remote host via agentd's CopyIn, over one persistent
 * connection reused for every exec in the sandbox's lifetime. See
 * docs/adr/0024-daemon-transport-for-fyre.md for why this exists alongside
 * (not instead of) `fyre()`.
 */
export const remoteDaemon = (
  options: RemoteDaemonOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "remote-daemon",
    env: options.env,
    create: async (
      createOptions: IsolatedCreateOptions,
    ): Promise<SandboxHandle> => {
      // createOptions.env is the fully-merged env dict from:
      //   .sandcastle/.env  +  process.env  +  bob({ env:{} })  +  remoteDaemon({ env:{} })
      const sessionEnv = createOptions.env;

      const daemon = await createDaemonClient({
        host: options.host,
        port: options.port,
        tls: options.tls,
        connectTimeoutMs: options.connectTimeoutMs,
      });

      const remoteRoot =
        options.remoteRoot ?? `/tmp/sandcastle-${randomUUID()}`;
      const worktreePath = posix.join(remoteRoot, "workspace");
      await daemonExec(
        daemon,
        `mkdir -p ${shellQuote(remoteRoot)} ${shellQuote(worktreePath)}`,
      );

      return {
        worktreePath,
        exec: (command, execOptions): Promise<ExecResult> =>
          daemonExec(
            daemon,
            command,
            { ...execOptions, env: sessionEnv },
            options.maxOutputTailChars,
          ),
        interactiveExec: (args, execOptions) =>
          daemonInteractiveExec(daemon, args, execOptions, sessionEnv),
        transfer: {
          copyIn: (hostPath, sandboxPath) =>
            daemonCopyIn(daemon, hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            daemonCopyOut(daemon, sandboxPath, hostPath),
        },
        close: async () => {
          try {
            await daemonExec(daemon, `rm -rf ${shellQuote(remoteRoot)}`);
          } finally {
            daemon.close();
          }
        },
      };
    },
  });

export type { IsolatedSandboxProvider };

// ---------------------------------------------------------------------------
// remoteDaemonNative — run the agent on a pre-existing remote repo (no sync)
// ---------------------------------------------------------------------------

export interface RemoteDaemonNativeOptions {
  /** Daemon hostname or IP. */
  readonly host: string;
  /** agentd's listen port. Default: 8443. */
  readonly port?: number;
  /** mTLS material. All three files are required. */
  readonly tls: DaemonTlsOptions;
  /**
   * Absolute path to the pre-existing repository on the remote host.
   * The agent runs directly inside this directory — nothing is copied
   * from the local machine and nothing is deleted on close().
   */
  readonly repoPath: string;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   */
  readonly maxOutputTailChars?: number;
  /** Fail fast if the daemon channel can't be established within this many ms (default: 5000). */
  readonly connectTimeoutMs?: number;
  /**
   * Shell used to execute commands on the remote host (default: `"bash"`).
   * Fyre machines use ksh as the login shell, which does not support `local`
   * and is incompatible with nvm and bob. Set to `"bash"` (the default) to
   * ensure bash is used regardless of the daemon's own default shell.
   */
  readonly shell?: string;
}

/**
 * Remote daemon native provider — runs the agent directly against a
 * pre-existing repository on a remote host over the daemon connection.
 * No repo sync or cleanup is performed.
 *
 * Because this provider has tag `"none"`, Sandcastle skips sync-in entirely.
 * `nativeGitTarget` (set below) tells SandboxLifecycle.ts to run
 * branch-strategy/merge/diff-collection git operations through this handle's
 * own `exec` against `repoPath`, exactly like `fyreNative()` — see
 * docs/adr/0022-sandbox-decoupling-seams.md's addendum. No new git-layer code
 * is needed for this provider.
 *
 * @example
 * ```typescript
 * import { run, bob } from "@ai-hero/sandcastle";
 * import { remoteDaemonNative } from "@ai-hero/sandcastle/sandboxes/remoteDaemon";
 *
 * await run({
 *   agent: bob("default"),
 *   sandbox: remoteDaemonNative({
 *     host: "fyre-machine-1",
 *     tls: { clientCertFile: "...", clientKeyFile: "...", caCertFile: "..." },
 *     repoPath: "/home/user/my-repo",
 *   }),
 *   prompt: "Fix the failing tests",
 * });
 * ```
 */
export const remoteDaemonNative = (
  options: RemoteDaemonNativeOptions,
): NoSandboxProvider => ({
  tag: "none",
  name: "remote-daemon-native",
  env: options.env ?? {},
  // repoPath lives on the remote host, not under the local hostRepoDir — see
  // NoSandboxProvider.nativeGitTarget and fyreNative()'s identical use of it.
  nativeGitTarget: true,

  create: async (createOptions): Promise<SandboxHandle> => {
    const worktreePath = options.repoPath;
    const sessionEnv = createOptions.env;
    const maxOutputTailChars = options.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const shell = options.shell ?? "bash";

    const daemon: DaemonClient = await createDaemonClient({
      host: options.host,
      port: options.port,
      tls: options.tls,
      connectTimeoutMs: options.connectTimeoutMs,
    });

    // Wrap the command in the chosen shell so it runs consistently regardless
    // of the daemon's own default shell — mirrors fyreNative()'s
    // buildNativeRemoteCommand.
    const wrapWithShell = (
      command: string,
      execOptions?: { cwd?: string; sudo?: boolean },
    ): string => {
      const sudoPrefix = execOptions?.sudo ? "sudo " : "";
      const cwd = execOptions?.cwd ?? worktreePath;
      const inner = `cd ${shellQuote(cwd)}; ${sudoPrefix}${command}`;
      return `${shell} -c ${shellQuote(inner)}`;
    };

    return {
      worktreePath,
      exec: (command, execOptions): Promise<ExecResult> =>
        daemonExec(
          daemon,
          wrapWithShell(command, execOptions),
          { ...execOptions, env: sessionEnv },
          maxOutputTailChars,
        ),
      interactiveExec: (args, execOptions) =>
        daemonInteractiveExec(
          daemon,
          [shell, "-c", wrapWithShell(args.map(shellQuote).join(" "))],
          execOptions,
          sessionEnv,
        ),
      close: async (): Promise<void> => {
        // No-op on the remote repo — it's pre-existing; nothing to tear
        // down, matching fyreNative(). Still release the daemon connection.
        daemon.close();
      },
    };
  },
});

export type { NoSandboxProvider };
