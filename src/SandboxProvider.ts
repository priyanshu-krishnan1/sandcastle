/**
 * Sandbox provider types — the pluggable interface for sandbox runtimes.
 *
 * Provider authors implement a small Promise-based interface. Sandcastle
 * handles worktree creation, git mount resolution, and commit extraction.
 */

/** Result of executing a command inside a sandbox. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Options for interactiveExec — the streams the provider should wire to the spawned process. */
export interface InteractiveExecOptions {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly cwd?: string;
}

/**
 * File transfer capability — present only on a `SandboxHandle` whose
 * filesystem is independent of the host (an "isolated" provider), where code
 * must be synced explicitly rather than being visible through a shared mount.
 */
export interface SandboxTransfer {
  /** Copy a file or directory from the host into the sandbox. */
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a single file from the sandbox to the host. */
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
}

/**
 * Handle to a running sandbox, regardless of provider category (bind-mount,
 * isolated, or no-sandbox). Replaces the three previously-separate
 * `BindMountSandboxHandle` / `IsolatedSandboxHandle` / `NoSandboxHandle`
 * interfaces, which differed only in whether `transfer` was present and
 * whether `interactiveExec` was required — properties now expressed as data
 * (an optional field) rather than as three structurally-duplicated types.
 *
 * `interactiveExec` is optional here even though `noSandbox()`'s own handle
 * always implements it (`interactive()`'s default provider genuinely
 * requires it at runtime) — that per-category "always present" guarantee is
 * deliberately not re-encoded at the type level for a custom `NoSandboxProvider`
 * author; `interactive()` fails at the call site if it's missing.
 */
export interface SandboxHandle {
  /** Absolute path to the worktree inside the sandbox (or on the host, for no-sandbox). */
  readonly worktreePath: string;
  /**
   * Execute a command in the sandbox.
   *
   * Implementations MUST support line-by-line streaming via `onLine`. This is
   * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
   * without a streaming implementation, neither will work. A buffered/batch
   * implementation that only calls `onLine` after the process exits does NOT
   * satisfy this contract.
   *
   * When `stdin` is set, the implementation pipes the string to the child
   * process's stdin and closes it. This avoids the Linux 128 KB per-arg limit.
   */
  exec(
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ): Promise<ExecResult>;
  /**
   * Launch an interactive process inside the sandbox.
   * Optional — providers that support interactive sessions implement this.
   * The provider detects TTY mode from the streams (e.g. stdin.isTTY) and
   * allocates a pseudo-terminal accordingly.
   */
  interactiveExec?(
    args: string[],
    options: InteractiveExecOptions,
  ): Promise<{ exitCode: number }>;
  /** File transfer capability — present only for providers with an independent filesystem. */
  readonly transfer?: SandboxTransfer;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to a bind-mount provider's `create` function. */
export interface BindMountCreateOptions {
  /** Host-side path to the worktree directory. */
  readonly worktreePath: string;
  /** Host-side path to the original repo root. */
  readonly hostRepoPath: string;
  /** Volume mounts to apply (host:sandbox pairs). */
  readonly mounts: Array<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }>;
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createBindMountSandboxProvider. */
export interface BindMountSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "docker", "podman"). */
  readonly name: string;
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Absolute path to the home directory inside the sandbox (e.g. `"/home/agent"`).
   * Used to expand `~` in user-provided `sandboxPath` mount configs.
   * Set to `undefined` for providers that do not have a fixed home directory.
   */
  readonly sandboxHomedir?: string;
  /** Create a sandbox handle from the given options. `transfer` should be
   *  omitted — bind-mount providers share the host filesystem via mount, so
   *  nothing in Sandcastle ever calls it. */
  readonly create: (options: BindMountCreateOptions) => Promise<SandboxHandle>;
}

/** Options passed to an isolated provider's `create` function. */
export interface IsolatedCreateOptions {
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createIsolatedSandboxProvider. */
export interface IsolatedSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "daytona", "e2b"). */
  readonly name: string;
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /** Create a sandbox handle from the given options. `transfer` must be
   *  implemented — isolated providers have their own filesystem, so code
   *  only reaches the sandbox via `transfer.copyIn`/`copyFileOut`. */
  readonly create: (options: IsolatedCreateOptions) => Promise<SandboxHandle>;
}

/**
 * Reads `handle.transfer`, throwing a descriptive error instead of the bare
 * `undefined.copyIn is not a function` a plain `handle.transfer!.copyIn(...)`
 * would produce. `transfer` is optional on `SandboxHandle` because
 * bind-mount/no-sandbox providers never implement it, but callers that reach
 * for it (`syncOut.ts`, `copyPaths` handling in `startSandbox.ts`) only ever
 * do so against an isolated provider's handle — a call-site invariant the
 * type system can't check since `SandboxHandle` is one unified interface.
 * This turns a violation of that invariant (e.g. a custom provider tagged
 * `"isolated"` that forgot to implement `transfer`) into a clear diagnostic
 * naming the caller, instead of a confusing crash deep inside `transfer`.
 */
export const requireTransfer = (
  handle: SandboxHandle,
  context: string,
): SandboxTransfer => {
  if (!handle.transfer) {
    throw new Error(
      `${context}: sandbox handle has no \`transfer\` implementation. ` +
        `Isolated providers must implement \`transfer.copyIn\`/\`copyFileOut\` ` +
        `in their \`create\` function — see IsolatedSandboxProviderConfig.create.`,
    );
  }
  return handle.transfer;
};

/** A bind-mount sandbox provider. */
export interface BindMountSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "bind-mount";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /**
   * Absolute path to the home directory inside the sandbox (e.g. `"/home/agent"`).
   * `undefined` when the provider does not declare a sandbox home directory.
   */
  readonly sandboxHomedir: string | undefined;
  /** @internal Create a sandbox handle. `transfer` should be omitted — see
   *  `BindMountSandboxProviderConfig.create`. */
  readonly create: (options: BindMountCreateOptions) => Promise<SandboxHandle>;
}

/** An isolated sandbox provider. */
export interface IsolatedSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "isolated";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /** @internal Create a sandbox handle. `transfer` must be implemented — see
   *  `IsolatedSandboxProviderConfig.create`. */
  readonly create: (options: IsolatedCreateOptions) => Promise<SandboxHandle>;
}

/** A no-sandbox provider — runs the agent directly on the host with no container isolation. */
export interface NoSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "none";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /**
   * Set when this provider's repo is NOT reachable via the local host's
   * filesystem at `hostRepoDir` — e.g. a remote-native provider (like
   * `fyreNative()`) that runs the agent directly against a pre-existing
   * repository on another machine, reached only through this handle's own
   * `exec`. `hostRepoDir`/`process.cwd()` have no relationship to where the
   * work actually happens in that case.
   *
   * Defaults to `false`/unset — the traditional no-sandbox case, where the
   * agent writes directly into `hostRepoDir` and it genuinely is where the
   * work happened.
   *
   * When `true`, `SandboxLifecycle.ts`'s branch-strategy/merge/diff-collection
   * step runs its git operations through this handle's `exec` (targeting its
   * `worktreePath`) instead of the local host's git — otherwise those
   * operations would silently run against the wrong repository.
   */
  readonly nativeGitTarget?: boolean;
  /** @internal Create a sandbox handle. `interactiveExec` must be
   *  implemented — `interactive()`'s default provider genuinely requires it
   *  at runtime; see the doc comment on `SandboxHandle.interactiveExec`. */
  readonly create: (options: {
    readonly worktreePath: string;
    readonly env: Record<string, string>;
  }) => Promise<SandboxHandle>;
}

// ---------- Branch strategy types ----------

/** Head strategy: agent writes directly to host working directory. Bind-mount only. */
export interface HeadBranchStrategy {
  readonly type: "head";
}

/** Merge-to-head strategy: temp branch, merge back to HEAD, delete temp branch. */
export interface MergeToHeadBranchStrategy {
  readonly type: "merge-to-head";
}

/** Branch strategy: commits land on an explicit named branch. */
export interface NamedBranchStrategy {
  readonly type: "branch";
  readonly branch: string;
  /**
   * Git ref to use as the starting point when creating a new branch.
   * Only used when the branch doesn't already exist — ignored otherwise.
   * Callers are responsible for ensuring the ref is current (e.g. `git fetch`).
   * Defaults to `HEAD` when omitted.
   */
  readonly baseBranch?: string;
}

/** Branch strategy for bind-mount providers (all three variants). */
export type BindMountBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for isolated providers (no head — can't write to host). */
export type IsolatedBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for no-sandbox providers (all three — same as bind-mount). */
export type NoSandboxBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Union of all branch strategy variants. */
export type BranchStrategy =
  | BindMountBranchStrategy
  | IsolatedBranchStrategy
  | NoSandboxBranchStrategy;

/**
 * A sandbox provider — the pluggable unit that `run()`, `interactive()`, and
 * `createSandbox()` accept. Tagged for internal dispatch: "bind-mount",
 * "isolated", or "none". When `NoSandboxProvider` is used, the agent runs
 * directly on the host with no container isolation — opt in at your own risk.
 */
export type SandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider
  | NoSandboxProvider;

/** @deprecated Use `SandboxProvider` — it now includes `NoSandboxProvider`. */
export type AnySandboxProvider = SandboxProvider;

/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createBindMountSandboxProvider = (
  config: BindMountSandboxProviderConfig,
): BindMountSandboxProvider => ({
  tag: "bind-mount",
  name: config.name,
  env: config.env ?? {},
  sandboxHomedir: config.sandboxHomedir,
  create: config.create,
});

/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  env: config.env ?? {},
  create: config.create,
});
