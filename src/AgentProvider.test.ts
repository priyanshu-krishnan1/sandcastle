import { describe, expect, it } from "vitest";
import { bob } from "./AgentProvider.js";
import type { AgentCommandOptions } from "./AgentProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

// ---------------------------------------------------------------------------
// bob factory
// ---------------------------------------------------------------------------

describe("bob factory", () => {
  it("returns a provider with name 'bob'", () => {
    const provider = bob("default");
    expect(provider.name).toBe("bob");
  });

  it("parseStreamLine extracts text from an assistant message", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello world",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine ignores user-role messages (the original prompt echoed back)", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "message",
      role: "user",
      content: "...instructions ending in <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts text+result from a success result with explicit result text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Final answer <promise>COMPLETE</promise>" },
      { type: "result", result: "Final answer <promise>COMPLETE</promise>" },
    ]);
  });

  it("parseStreamLine does NOT fabricate the completion signal for a bare success result", () => {
    // bob run --format stream-json emits {"type":"result","status":"success","stats":{...}}
    // with no text content on ordinary turn completion — this must NOT be treated
    // as the agent asserting <promise>COMPLETE</promise>, or every phase gated on
    // that signal would report success regardless of whether the task actually
    // finished (see incident: a stray backgrounded child process produced exactly
    // this event mid-task and the fabricated signal made Orchestrator.ts report
    // the iteration as cleanly complete). Usage extraction still runs alongside
    // this guard (see the "extracts usage" tests below) — here `stats` carries no
    // recognized numeric fields, so every usage field defaults to 0.
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: { turns: 3 },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
  });

  it("parseStreamLine surfaces an error result via the tool_call channel, never as text", () => {
    // A {"type":"result","status":"error"} is a real assistant-produced failure
    // message, but it must never be scanned for the completion signal alongside
    // ordinary assistant text (accumulatedOutput in Orchestrator.ts only accrues
    // from "text"/"result" events). Routing it through onToolCall instead of
    // onText keeps it visible for debugging without that risk — mirroring the
    // choice made for the top-level {"type":"error"} event below.
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "error",
      error: "bob crashed",
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      { type: "tool_call", name: "error", args: "bob crashed" },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("parseStreamLine falls back to a generic message for an error result with no error field", () => {
    const provider = bob("default");
    const line = JSON.stringify({ type: "result", status: "error" });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      { type: "tool_call", name: "error", args: "bob run failed" },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("parseStreamLine extracts a tool_call", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_call",
      name: "Bash",
      args: "npm test",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine extracts a session_id", () => {
    const provider = bob("default");
    const line = JSON.stringify({ type: "session_id", sessionId: "abc123" });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "abc123" },
    ]);
  });

  it("parseStreamLine treats non-JSON lines as plain text", () => {
    const provider = bob("default");
    expect(provider.parseStreamLine("plain shell output")).toEqual([
      { type: "text", text: "plain shell output" },
    ]);
  });

  it("buildPrintCommand delivers prompt via stdin and uses stream-json format", () => {
    const provider = bob("default");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("bob run --format stream-json");
    expect(stdin).toBe("do something");
  });
});

// ---------------------------------------------------------------------------
// Bob 2.0 real stream-json event vocabulary
// ---------------------------------------------------------------------------

describe("bob 2.0 stream-json event mapping", () => {
  // --- tool_use / tool_result (item 1) -------------------------------------

  it("maps a tool_use event to a tool_call, never to text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_use",
      tool_name: "Bash",
      tool_id: "t1",
      parameters: { command: "ls -la" },
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      {
        type: "tool_call",
        name: "Bash",
        args: JSON.stringify({ command: "ls -la" }),
      },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("maps a successful tool_result event to a tool_call carrying the output, never to text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "t1",
      status: "success",
      output: "file1.txt\nfile2.txt",
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      { type: "tool_call", name: "tool_result", args: "file1.txt\nfile2.txt" },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("maps a failed tool_result event's error to a tool_call, never to text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "t1",
      status: "error",
      error: "command not found",
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      { type: "tool_call", name: "tool_result", args: "command not found" },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("stringifies a non-string tool_result output instead of dropping it", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "t1",
      status: "success",
      output: { files: ["a.ts", "b.ts"], count: 2 },
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      {
        type: "tool_call",
        name: "tool_result",
        args: JSON.stringify({ files: ["a.ts", "b.ts"], count: 2 }),
      },
    ]);
  });

  it("stringifies a non-string tool_result error instead of dropping it", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "t1",
      status: "error",
      error: { code: "ENOENT", path: "/tmp/x" },
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      {
        type: "tool_call",
        name: "tool_result",
        args: JSON.stringify({ code: "ENOENT", path: "/tmp/x" }),
      },
    ]);
  });

  it("a tool_use whose parameters happen to contain the completion signal is never eligible for text/completion scanning", () => {
    // Regression guard for the exact scenario in the task description: a tool
    // call that writes a prompt file, or greps for the marker, containing the
    // literal signal string in its parameters must not leak into onText/
    // accumulatedOutput in Orchestrator.ts.
    const provider = bob("default");
    const line = JSON.stringify({
      type: "tool_use",
      tool_name: "Write",
      tool_id: "t2",
      parameters: { content: "<promise>COMPLETE</promise>" },
    });
    const events = provider.parseStreamLine(line);
    expect(events.every((e) => e.type === "tool_call")).toBe(true);
  });

  // --- reasoning content (item 2) -------------------------------------------

  it("surfaces reasoning-flagged assistant messages as non-assertive text, never eligible for completion matching", () => {
    // Reasoning content can plausibly discuss or quote the completion signal
    // string without the agent actually asserting completion (e.g. "once I
    // see <promise>COMPLETE</promise> I should stop"), so it must never reach
    // Orchestrator.ts's completion-signal-eligible accumulatedOutput buffer —
    // but it should still be visible to the user via onText, hence
    // `assertive: false` rather than dropping the event entirely.
    const provider = bob("default");
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      isReasoning: true,
      content: "Once everything passes I'll emit <promise>COMPLETE</promise>.",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "text",
        text: "Once everything passes I'll emit <promise>COMPLETE</promise>.",
        assertive: false,
      },
    ]);
  });

  it("drops a reasoning-flagged assistant message with no usable content", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      isReasoning: true,
      content: "",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("still extracts text from a non-reasoning assistant message", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      isReasoning: false,
      content: "Running the tests now.",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Running the tests now." },
    ]);
  });

  // --- top-level error event (item 3) ---------------------------------------

  it("maps a top-level error event to a tool_call so it is visible without being completion-eligible", () => {
    // Divergence from a literal reading of "error" as assistant text: routing
    // through the tool_call channel (onToolCall) rather than text (onText/
    // accumulatedOutput) means it can never accidentally match a completion
    // signal, while still surfacing for debugging via the tool-call display.
    const provider = bob("default");
    const line = JSON.stringify({
      type: "error",
      severity: "fatal",
      message: "sandbox disk full",
    });
    const events = provider.parseStreamLine(line);
    expect(events).toEqual([
      { type: "tool_call", name: "error", args: "sandbox disk full" },
    ]);
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  // --- usage extraction from a result event's stats (item 4) ----------------

  it("extracts a usage event from a successful result's stats, alongside its last_message text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      last_message: "All done here.",
      stats: {
        task_id: "task-1",
        total_tokens: 315,
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        duration_ms: 1234,
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "All done here." },
      { type: "result", result: "All done here." },
      {
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 5,
        },
      },
      { type: "session_id", sessionId: "task-1" },
    ]);
  });

  it("defaults missing numeric usage fields to 0 without throwing", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: { input_tokens: 42 },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 42,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
  });

  // --- task id extraction from a result event's stats ------------------------

  const zeroedUsage = {
    type: "usage" as const,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };

  it("extracts the task id as a session_id event from a bare successful result (no text content)", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: { task_id: "task-42" },
    });
    // stats is a non-null object, so extractBobUsage also fires (zeroed —
    // no token fields present here); both events are independent extractions.
    expect(provider.parseStreamLine(line)).toEqual([
      zeroedUsage,
      { type: "session_id", sessionId: "task-42" },
    ]);
  });

  it("extracts the task id even on an error result — a caller may want to retry against it", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "error",
      error: "bob crashed",
      stats: { task_id: "task-99" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "error", args: "bob crashed" },
      zeroedUsage,
      { type: "session_id", sessionId: "task-99" },
    ]);
  });

  it("does not emit a session_id event when task_id is absent, non-string, or stats itself is missing", () => {
    const provider = bob("default");
    const missingTaskId = JSON.stringify({
      type: "result",
      status: "success",
      stats: { total_tokens: 10 },
    });
    const nonStringTaskId = JSON.stringify({
      type: "result",
      status: "success",
      stats: { task_id: 12345 },
    });
    const missingStats = JSON.stringify({
      type: "result",
      status: "success",
      last_message: "done",
    });

    for (const line of [missingTaskId, nonStringTaskId, missingStats]) {
      const events = provider.parseStreamLine(line);
      expect(events.some((e) => e.type === "session_id")).toBe(false);
    }
  });

  // --- BobOptions CLI flags (item 6) -----------------------------------------

  it("buildPrintCommand omits all optional flags when unset except the trust/accept-license defaults", () => {
    const provider = bob("default");
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).not.toContain("--max-turns");
    expect(command).not.toContain("--max-cost");
    expect(command).not.toContain("--disable-tool-groups");
    expect(command).not.toContain("--disable-mcp");
    expect(command).not.toContain("--disable-subagents");
    expect(command).not.toContain("--workspace");
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand renders maxTurns as --max-turns", () => {
    const provider = bob("default", { maxTurns: 12 });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--max-turns 12");
  });

  it("buildPrintCommand renders maxCost as --max-cost", () => {
    const provider = bob("default", { maxCost: 5 });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--max-cost 5");
  });

  it("buildPrintCommand renders disableToolGroups as a comma-separated --disable-tool-groups", () => {
    const provider = bob("default", { disableToolGroups: ["execute", "mcp"] });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--disable-tool-groups");
    expect(command).toContain("execute,mcp");
  });

  it("buildPrintCommand renders disableMcp as --disable-mcp", () => {
    const provider = bob("default", { disableMcp: true });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--disable-mcp");
  });

  it("buildPrintCommand renders disableSubagents as --disable-subagents", () => {
    const provider = bob("default", { disableSubagents: true });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--disable-subagents");
  });

  it("buildPrintCommand renders workspace as --workspace", () => {
    const provider = bob("default", { workspace: "/work/dir" });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--workspace");
    expect(command).toContain("/work/dir");
  });

  it("defaults trust and acceptLicense to true so a headless run never hangs on a first-run prompt", () => {
    const provider = bob("default");
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).toContain("--trust");
    expect(command).toContain("--accept-license");
  });

  it("omits --trust when trust is explicitly false", () => {
    const provider = bob("default", { trust: false });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).not.toContain("--trust");
  });

  it("omits --accept-license when acceptLicense is explicitly false", () => {
    const provider = bob("default", { acceptLicense: false });
    const { command } = provider.buildPrintCommand(opts("hi"));
    expect(command).not.toContain("--accept-license");
  });

  // --- --resume plumbing (item 7) --------------------------------------------

  it("buildPrintCommand wires resumeSession into --resume", () => {
    const provider = bob("default");
    const { command } = provider.buildPrintCommand({
      prompt: "hi",
      dangerouslySkipPermissions: true,
      resumeSession: "task-123",
    });
    expect(command).toContain("--resume");
    expect(command).toContain("task-123");
  });

  it("does not declare sessionStorage for bob (no filesystem-backed session record to transfer)", () => {
    const provider = bob("default");
    expect(provider.sessionStorage).toBeUndefined();
    expect(provider.captureSessions).toBe(false);
  });

  // --- buildInteractiveArgs must see the same budget/permission flags -------
  // (review-pass regression: these options were wired into buildPrintCommand
  // but not into buildInteractiveArgs, so `interactive()`/`createSandbox()`/
  // `createWorktree()` interactive sessions silently ran with none of them.)

  it("buildInteractiveArgs includes the same budget/permission/resume flags as buildPrintCommand", () => {
    const provider = bob("default", {
      maxTurns: 10,
      maxCost: 5,
      disableToolGroups: ["edit", "execute"],
      disableMcp: true,
      disableSubagents: true,
      workspace: "/repo",
    });
    const args = provider.buildInteractiveArgs!({
      prompt: "hi",
      dangerouslySkipPermissions: true,
      resumeSession: "task-123",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--max-turns",
        "10",
        "--max-cost",
        "5",
        "--disable-tool-groups",
        "edit,execute",
        "--disable-mcp",
        "--disable-subagents",
        "--workspace",
        "/repo",
        "--resume",
        "task-123",
      ]),
    );
  });

  it("buildInteractiveArgs omits --trust and --accept-license even though they default to true for the headless path", () => {
    // Deliberate divergence from buildPrintCommand: trust/accept-license exist
    // to skip a first-run prompt nothing is present to answer headlessly. An
    // interactive session has a human at the terminal who should see that
    // prompt, not have it silently auto-accepted on their behalf.
    const provider = bob("default");
    const args = provider.buildInteractiveArgs!({
      prompt: "hi",
      dangerouslySkipPermissions: true,
    });
    expect(args).not.toContain("--trust");
    expect(args).not.toContain("--accept-license");
  });
});
