import type { SandboxHandle } from "./SandboxProvider.js";
import type { HostSessionLookup } from "./SessionStore.js";

export type ParsedStreamEvent =
  | {
      type: "text";
      text: string;
      /**
       * Whether this text is the agent asserting something, eligible for
       * completion-signal matching in Orchestrator.ts. Omitted or `true` is
       * the default — matching every provider's behavior before this field
       * existed. Explicit `false` marks text that should still reach the
       * user (chain-of-thought/reasoning commentary) but must never be
       * scanned for the completion signal, since it can plausibly mention or
       * quote the signal string without the agent actually asserting
       * completion — see the `isReasoning` handling below.
       */
      assertive?: boolean;
    }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string }
  | { type: "usage"; usage: IterationUsage };

/** Options passed to buildPrintCommand and buildInteractiveArgs. */
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
  /** When set, the agent should resume the given session ID instead of starting fresh. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, the agent should fork the session
   * instead of mutating it. The parent session JSONL is left intact and the
   * agent writes a new session under a fresh id.
   */
  readonly forkSession?: boolean;
}

/** Return type of buildPrintCommand — command string plus optional stdin content.
 *  When `stdin` is set, the sandbox pipes it to the child process's stdin
 *  instead of inlining the prompt in argv, avoiding the Linux 128 KB per-arg limit. */
export interface PrintCommand {
  readonly command: string;
  readonly stdin?: string;
}

/** Per-iteration token usage snapshot extracted from the agent session. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface AgentSessionStorage {
  /** Transfer a session JSONL from the sandbox into the host store. */
  captureToHost(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: SandboxHandle;
  }): Promise<void>;
  /** Transfer a session JSONL from the host store into the sandbox. */
  resumeIntoSandbox(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: SandboxHandle;
  }): Promise<void>;
  /** Read a captured session JSONL from the host store. Returns undefined when absent. */
  readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
  /** Whether a session with the given id exists in the host store keyed on cwd. */
  existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
  /** Absolute host path where a session would be stored (for not-found error messages). */
  hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
  /**
   * Locate a session on the host by its unique id, independent of cwd encoding.
   * Used by the no-sandbox resume precheck, where the agent runs on the host and
   * writes the session in place under a cwd-derived directory Sandcastle cannot
   * reliably reconstruct. Returns the located path (or `undefined`) plus the
   * directory that was searched (for not-found errors).
   */
  findByIdOnHost(sessionId: string): Promise<HostSessionLookup>;
}

export interface AgentProvider {
  readonly name: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  /** When true, session capture is enabled for this provider. */
  readonly captureSessions: boolean;
  /** Provider-owned storage and transfer behavior for resumable agent sessions. */
  readonly sessionStorage?: AgentSessionStorage;
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  /** Parse token usage from the captured session JSONL content. */
  parseSessionUsage?(content: string): IterationUsage | undefined;
}
