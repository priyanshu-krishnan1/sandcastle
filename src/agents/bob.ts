import { shellQuote } from "../utils/shellQuote.js";
import type {
  AgentProvider,
  AgentCommandOptions,
  PrintCommand,
  ParsedStreamEvent,
} from "../AgentProvider.js";

/** Coerce a possibly-missing/non-numeric field to a finite number, defaulting to 0. */
const numOr0 = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * Best-effort extraction of an IterationUsage from a `result` event's `stats`
 * object. Field names are inferred from IBM's docs (task_id, total_tokens,
 * input_tokens, output_tokens, cache metrics, duration_ms, session_costs,
 * tool_calls) rather than confirmed against a live response, so every field
 * defaults to 0 instead of throwing when a name doesn't match or `stats` is
 * missing/malformed. Returns undefined only when there is no stats object at
 * all, so callers can distinguish "no usage event" from "zeroed usage event".
 */
const extractBobUsage = (stats: unknown): ParsedStreamEvent | undefined => {
  if (typeof stats !== "object" || stats === null) return undefined;
  const s = stats as Record<string, unknown>;
  return {
    type: "usage",
    usage: {
      inputTokens: numOr0(s.input_tokens),
      outputTokens: numOr0(s.output_tokens),
      cacheCreationInputTokens: numOr0(s.cache_creation_input_tokens),
      cacheReadInputTokens: numOr0(s.cache_read_input_tokens),
    },
  };
};

/**
 * Best-effort extraction of bob's task id from a `result` event's `stats`
 * object, surfaced as a `session_id` event so `IterationResult.sessionId`
 * gets populated the same way it would for a filesystem-backed provider —
 * bob has no `AgentSessionStorage` (see the `bob()` factory comment below),
 * but `resumeSession` already flows into `buildPrintCommand` as `--resume
 * <task-id>` unconditionally, independent of `sessionStorage`. Without this,
 * a caller has no way to discover the id a follow-up `run({ resumeSession })`
 * would need, even though the mechanism already works. `task_id` is named
 * per IBM's docs (same inferred-not-confirmed basis as `extractBobUsage`'s
 * fields) — returns undefined rather than guessing when absent or non-string.
 */
const extractBobTaskId = (stats: unknown): ParsedStreamEvent | undefined => {
  if (typeof stats !== "object" || stats === null) return undefined;
  const taskId = (stats as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId.length > 0
    ? { type: "session_id", sessionId: taskId }
    : undefined;
};

/**
 * Parse Bob-Shell output lines into Sandcastle events.
 * Bob-Shell outputs plain text by default, but may also output structured JSON.
 */
const parseBobStreamLine = (line: string): ParsedStreamEvent[] => {
  // Try JSON parsing first
  if (line.startsWith("{")) {
    try {
      const obj = JSON.parse(line);

      // Real `bob run --format stream-json` (Bob-Shell 2.0) event vocabulary,
      // confirmed from IBM's docs:
      //   {"type":"message","role":...,"content":"...","isReasoning":bool}
      //   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...}}
      //   {"type":"tool_result","tool_id":"...","status":"...","output"|"error":"..."}
      //   {"type":"error","severity":"...","message":"..."}
      //   {"type":"result","status":"success"|"error","last_message":"...","stats":{...}}

      if (
        obj.type === "message" &&
        obj.role === "assistant" &&
        obj.isReasoning === true
      ) {
        // Reasoning content (chain-of-thought style commentary) is surfaced
        // as text — visible to onText/display — but marked non-assertive so
        // it can never reach accumulatedOutput. Reasoning text can plausibly
        // mention or quote the completion signal string (e.g. "once I see
        // <promise>COMPLETE</promise> I'm done") without the agent actually
        // asserting completion; letting it into the signal-matching buffer in
        // Orchestrator.ts would fire on a thought rather than a real
        // assertion. Previously dropped entirely (`return []`) — that hid
        // reasoning from the user; assertive:false gets the same safety
        // without the loss of visibility.
        return typeof obj.content === "string" && obj.content.length > 0
          ? [{ type: "text", text: obj.content, assertive: false }]
          : [];
      }

      if (
        obj.type === "message" &&
        obj.role === "assistant" &&
        typeof obj.content === "string"
      ) {
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

      // tool_use / tool_result: Bob 2.0's actual tool-call event pair. These
      // must NEVER fall through to the raw-JSON-as-text default below — a
      // tool call that writes a prompt file, or greps for the completion
      // marker, can easily carry the literal signal string in its parameters
      // or output, which would otherwise fabricate a completion the agent
      // never asserted. Mapped onto the existing "tool_call" event so they
      // render via onToolCall (never onText/accumulatedOutput).
      if (obj.type === "tool_use" && typeof obj.tool_name === "string") {
        return [
          {
            type: "tool_call",
            name: obj.tool_name,
            args:
              obj.parameters !== undefined
                ? JSON.stringify(obj.parameters)
                : "",
          },
        ];
      }

      if (obj.type === "tool_result") {
        // Mirror tool_use's parameters handling: a structured (non-string)
        // output/error must not be silently dropped to "" — that leaves the
        // log with no visibility into what the tool actually returned.
        const detail =
          typeof obj.output === "string"
            ? obj.output
            : typeof obj.error === "string"
              ? obj.error
              : obj.output !== undefined
                ? JSON.stringify(obj.output)
                : obj.error !== undefined
                  ? JSON.stringify(obj.error)
                  : "";
        return [{ type: "tool_call", name: "tool_result", args: detail }];
      }

      // Top-level {"type":"error"} event. Deliberate divergence from a literal
      // reading of "error" as assistant-produced message text: routed through
      // the tool_call channel (onToolCall) rather than text (onText/
      // accumulatedOutput) so it stays visible for debugging without ever
      // being eligible to match the completion signal.
      if (obj.type === "error") {
        const msg = typeof obj.message === "string" ? obj.message : "bob error";
        return [{ type: "tool_call", name: "error", args: msg }];
      }

      if (obj.type === "result") {
        const usageEvent = extractBobUsage(obj.stats);
        const sessionIdEvent = extractBobTaskId(obj.stats);
        if (obj.status === "success") {
          const text =
            typeof obj.last_message === "string"
              ? obj.last_message
              : typeof obj.result === "string"
                ? obj.result
                : undefined;
          if (text !== undefined) {
            return [
              { type: "text", text },
              { type: "result", result: text },
              ...(usageEvent ? [usageEvent] : []),
              ...(sessionIdEvent ? [sessionIdEvent] : []),
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
          // Emit nothing but the usage/session-id extraction; the real
          // signal-matching logic in Orchestrator.ts only fires if the
          // agent's own assistant-message text already contains the
          // completion signal.
          return [
            ...(usageEvent ? [usageEvent] : []),
            ...(sessionIdEvent ? [sessionIdEvent] : []),
          ];
        }
        // error status — route through the tool_call channel (see the
        // top-level {"type":"error"} comment above) rather than text, so a
        // failure result can never be mistaken for a real assistant message
        // eligible for completion-signal matching. Orchestrator.ts's own
        // exit-code path is what actually fails the run. The task id is
        // still worth surfacing on a failed turn — it's what a caller would
        // pass to `resumeSession` to retry against the same task.
        if (obj.status === "error") {
          const msg =
            typeof obj.error === "string" ? obj.error : "bob run failed";
          return [
            { type: "tool_call", name: "error", args: msg },
            ...(usageEvent ? [usageEvent] : []),
            ...(sessionIdEvent ? [sessionIdEvent] : []),
          ];
        }
      }

      // Legacy/defensive: an assumed Bob-Shell 1.x-shaped {"type":"tool_call"}
      // event. Bob 2.0 never emits this (it uses tool_use/tool_result above),
      // but the shape is kept as a harmless additional match in case a caller
      // is fronting a different Bob-Shell version.
      if (obj.type === "tool_call" && typeof obj.name === "string") {
        return [
          {
            type: "tool_call",
            name: obj.name,
            args: typeof obj.args === "string" ? obj.args : "",
          },
        ];
      }

      // Legacy/defensive: an assumed {"type":"session_id"} event. Bob 2.0's
      // real protocol has no such event (see AgentSessionStorage comment on
      // the `bob()` factory below for why session resume isn't wired at all);
      // kept only as a harmless additional match.
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
  /**
   * Bob-Shell mode to use. Despite the field name (kept for backwards
   * compatibility with the positional `model` argument on `bob()`), this is
   * rendered as `bob run`'s `--mode` flag, not `--model` — Bob 2.0's `run`
   * command has no `--model` flag.
   */
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
  /** Rendered as `bob run --max-turns <n>`, capping the number of agent turns per invocation. */
  readonly maxTurns?: number;
  /** Rendered as `bob run --max-cost <n>`, capping spend (in bobcoins) per invocation. */
  readonly maxCost?: number;
  /**
   * Rendered as `bob run --disable-tool-groups <a,b,...>`. Valid groups per
   * Bob's CLI: read, edit, execute, mcp, skill, todo, subagent, mode.
   */
  readonly disableToolGroups?: string[];
  /** Rendered as `bob run --disable-mcp`. */
  readonly disableMcp?: boolean;
  /** Rendered as `bob run --disable-subagents`. */
  readonly disableSubagents?: boolean;
  /** Rendered as `bob run --workspace <path>`. */
  readonly workspace?: string;
  /**
   * Rendered as `bob run --trust`. Defaults to `true`: bob runs headless
   * inside an ephemeral or remote sandbox with no human present to answer a
   * first-run trust prompt, and an unanswered prompt would otherwise hang
   * until the idle timeout. Pass `false` explicitly to restore the prompt.
   */
  readonly trust?: boolean;
  /**
   * Rendered as `bob run --accept-license`. Defaults to `true` for the same
   * headless-hang reason as `trust` above. Pass `false` explicitly to restore
   * the prompt.
   */
  readonly acceptLicense?: boolean;
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

  // Defaults mirror bob's non-interactive CLI expectations: with no human
  // present to answer a first-run trust/license prompt, an unanswered prompt
  // hangs until the idle timeout. See the BobOptions doc comments.
  const trust = options?.trust ?? true;
  const acceptLicense = options?.acceptLicense ?? true;

  // Flags shared between the headless (buildPrintCommand) and interactive
  // (buildInteractiveArgs) paths: mode, budget caps, tool-group and MCP/
  // subagent restrictions, workspace override, and resume. Kept as a single
  // source of truth so a new option can't be added to one path and silently
  // missed on the other (as maxTurns/maxCost/disableToolGroups/disableMcp/
  // disableSubagents/workspace/resumeSession originally were on
  // buildInteractiveArgs). `escape` marks free-text values that need shell
  // quoting in buildPrintCommand — buildInteractiveArgs ignores it since argv
  // array entries never pass through a shell. --trust/--accept-license are
  // intentionally NOT included here — see the comment on buildInteractiveArgs
  // below.
  const collectSharedArgs = (
    resumeSession?: string,
  ): {
    readonly flag: string;
    readonly value?: string;
    readonly escape?: boolean;
  }[] => {
    const args: { flag: string; value?: string; escape?: boolean }[] = [];
    if (resolvedModel && resolvedModel !== "default") {
      args.push({ flag: "--mode", value: resolvedModel, escape: true });
    }
    if (options?.maxTurns !== undefined) {
      args.push({ flag: "--max-turns", value: String(options.maxTurns) });
    }
    if (options?.maxCost !== undefined) {
      args.push({ flag: "--max-cost", value: String(options.maxCost) });
    }
    if (options?.disableToolGroups && options.disableToolGroups.length > 0) {
      args.push({
        flag: "--disable-tool-groups",
        value: options.disableToolGroups.join(","),
        escape: true,
      });
    }
    if (options?.disableMcp) {
      args.push({ flag: "--disable-mcp" });
    }
    if (options?.disableSubagents) {
      args.push({ flag: "--disable-subagents" });
    }
    if (options?.workspace !== undefined) {
      args.push({
        flag: "--workspace",
        value: options.workspace,
        escape: true,
      });
    }
    if (resumeSession !== undefined) {
      args.push({ flag: "--resume", value: resumeSession, escape: true });
    }
    return args;
  };

  return {
    name: "bob",
    env: options?.env ?? {},
    captureSessions: false,
    // No `sessionStorage` declared: per ADR 0016, resume support requires a
    // filesystem-backed session record Sandcastle can copy verbatim (as Claude
    // Code, Codex, and Pi have). Bob's session model is a remote task-id
    // (`--resume <task-id>` / `--resume latest`), not a file Sandcastle can
    // read/transfer/rewrite — the same category as OpenCode's SQLite store,
    // which ADR 0016 explicitly leaves unresumable. `--resume` is still wired
    // into buildPrintCommand below (see AgentCommandOptions.resumeSession) so
    // the CLI plumbing exists for when/if a filesystem-backed approach is
    // designed; it is a harmless no-op today since nothing sets
    // `resumeSession` for a provider with no `sessionStorage`.

    buildPrintCommand({
      prompt,
      resumeSession,
    }: AgentCommandOptions): PrintCommand {
      const flagParts = collectSharedArgs(resumeSession)
        .concat(
          trust ? [{ flag: "--trust" }] : [],
          acceptLicense ? [{ flag: "--accept-license" }] : [],
        )
        .map(({ flag, value, escape }) =>
          value === undefined
            ? flag
            : `${flag} ${escape ? shellQuote(value) : value}`,
        )
        .join(" ");
      const flags = flagParts ? ` ${flagParts}` : "";

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
        command: `${setupPrefix}${installCheck} && ${rehashPath} && bob run --format stream-json${flags}`,
        stdin: prompt,
      };
    },

    buildInteractiveArgs({
      prompt,
      resumeSession,
    }: AgentCommandOptions): string[] {
      // Deliberately excludes --trust/--accept-license: those exist only to
      // skip a first-run prompt when nothing is present to answer it headlessly
      // (see BobOptions doc comments). An interactive session has a human at
      // the terminal who should see and answer that prompt themselves, not
      // have it silently auto-accepted on their behalf.
      const args = ["bob", "run"];
      for (const { flag, value } of collectSharedArgs(resumeSession)) {
        args.push(flag);
        if (value !== undefined) args.push(value);
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
