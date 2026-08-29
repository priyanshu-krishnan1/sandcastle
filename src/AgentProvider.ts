import type { BindMountSandboxHandle } from "./SandboxProvider.js";
import type { HostSessionLookup } from "./SessionStore.js";

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string }
  | { type: "usage"; usage: IterationUsage };

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

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
    handle: BindMountSandboxHandle;
  }): Promise<void>;
  /** Transfer a session JSONL from the host store into the sandbox. */
  resumeIntoSandbox(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: BindMountSandboxHandle;
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

// ---------------------------------------------------------------------------
// Bob-Shell agent provider
// ---------------------------------------------------------------------------

/**
 * Parse Bob-Shell output lines into Sandcastle events.
 * Bob-Shell outputs plain text by default, but may also output structured JSON.
 */
const parseBobStreamLine = (line: string): ParsedStreamEvent[] => {
  // Try JSON parsing first
  if (line.startsWith("{")) {
    try {
      const obj = JSON.parse(line);

      // bob run --format stream-json emits:
      //   {"type":"message","role":"assistant","content":"..."} — streamed text chunks
      //   {"type":"result","status":"success","stats":{...}}    — final completion
      //   {"type":"result","status":"error",...}                — failure

      if (obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string") {
        return [{ type: "text", text: obj.content }];
      }

      // A "message" event with any other role (e.g. "user" — bob echoing the
      // prompt it was given back on the stream) must be dropped, not fall
      // through to the raw-JSON-as-text default below. The prompt text itself
      // routinely contains the literal completion signal (it's the
      // instruction telling the agent when to emit it), so echoing it back
      // as a "text" event would let the signal-matching in Orchestrator.ts
      // fire before the agent ever said anything.
      if (obj.type === "message") {
        return [];
      }

      if (obj.type === "result") {
        if (obj.status === "success") {
          if (typeof obj.result === "string") {
            return [
              { type: "text", text: obj.result },
              { type: "result", result: obj.result },
            ];
          }
          // bob run --format stream-json emits {"type":"result","status":"success","stats":{...}}
          // with no text content — this only means the CLI process/turn exited
          // cleanly, not that the agent actually asserted completion. Do NOT
          // fabricate the completion signal here: a bare process exit (e.g. a
          // stray backgrounded child holding stdout open, or the agent simply
          // running out of things to do this turn) would otherwise be
          // indistinguishable from the agent genuinely emitting
          // <promise>COMPLETE</promise>, causing Orchestrator.ts to report the
          // iteration — and any phase gated on it — as successfully complete
          // even though the actual task was never finished or verified.
          // Emit nothing; the real signal-matching logic in Orchestrator.ts
          // only fires if the agent's own assistant-message text already
          // contains the completion signal.
          return [];
        }
        // error status — surface as plain text so it appears in logs
        if (obj.status === "error") {
          const msg = typeof obj.error === "string" ? obj.error : "bob run failed";
          return [{ type: "text", text: msg }];
        }
      }

      // Handle tool calls
      if (obj.type === "tool_call" && typeof obj.name === "string") {
        return [
          {
            type: "tool_call",
            name: obj.name,
            args: typeof obj.args === "string" ? obj.args : "",
          },
        ];
      }

      // Handle session ID if Bob supports it
      if (obj.type === "session_id" && typeof obj.sessionId === "string") {
        return [{ type: "session_id", sessionId: obj.sessionId }];
      }
    } catch {
      // Not valid JSON, fall through to plain text handling
    }
  }

  // Default: treat as plain text output
  return [{ type: "text", text: line }];
};

/** Options for the Bob-Shell agent provider. */
export interface BobOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** Bob-Shell model or configuration to use */
  readonly model?: string;
  /**
   * Shell snippet prepended to every bob command before the install check.
   * Use this to source runtime managers (nvm, rvm, etc.) or set PATH on
   * remote hosts where non-interactive SSH sessions don't load a login profile.
   *
   * @example
   * // Load nvm so Node is on PATH on a Fyre machine:
   * setupScript: 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
   */
  readonly setupScript?: string;
}

/**
 * Bob-Shell agent provider for Sandcastle.
 *
 * Runs autonomous coding tasks in isolated sandbox environments using Bob.
 *
 * @example
 * ```typescript
 * import { run, bob } from "@ai-hero/sandcastle";
 * import { fyre } from "@ai-hero/sandcastle/sandboxes/fyre";
 *
 * await run({
 *   agent: bob("default"),
 *   sandbox: fyre({ host: "fyre-x86" }),
 *   prompt: "Fix the issues in this repository",
 *   maxIterations: 5,
 * });
 * ```
 */
export const bob = (model: string, options?: BobOptions): AgentProvider => {
  // Prefer explicit options.model over the positional model argument.
  const resolvedModel = options?.model ?? model;

  return {
  name: "bob",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({ prompt }: AgentCommandOptions): PrintCommand {
    const modeFlag =
      resolvedModel && resolvedModel !== "default"
        ? ` --mode ${shellEscape(resolvedModel)}`
        : "";

    // Optional setup snippet (e.g. sourcing nvm) runs first so Node/bob are
    // on PATH before the install check executes.
    const setupPrefix = options?.setupScript
      ? `${options.setupScript} && `
      : "";

    // Auto-install bob if it is not present on the remote machine.
    const installCheck =
      `if ! type bob >/dev/null 2>&1; then` +
      ` echo "[sandcastle] bob not found - installing..." >&2;` +
      ` curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash >&2` +
      ` || { echo "[sandcastle] bob install failed" >&2; exit 1; };` +
      ` fi`;

    // After install bob lands in npm's global bin dir — add it to PATH so the
    // subsequent `bob run` resolves without starting a new login shell.
    const rehashPath = `export PATH="$(npm root -g 2>/dev/null | sed 's|/node_modules$|/bin|'):$PATH"`;

    return {
      command: `${setupPrefix}${installCheck} && ${rehashPath} && bob run --format stream-json${modeFlag}`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["bob", "run"];

    if (resolvedModel && resolvedModel !== "default") {
      args.push("--mode", resolvedModel);
    }

    if (prompt) {
      args.push(prompt);
    }

    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseBobStreamLine(line);
  },
  };
};
