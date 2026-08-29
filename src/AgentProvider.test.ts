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
    // the iteration as cleanly complete).
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: { turns: 3 },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine surfaces an error result as plain text", () => {
    const provider = bob("default");
    const line = JSON.stringify({
      type: "result",
      status: "error",
      error: "bob crashed",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "bob crashed" },
    ]);
  });

  it("parseStreamLine falls back to a generic message for an error result with no error field", () => {
    const provider = bob("default");
    const line = JSON.stringify({ type: "result", status: "error" });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "bob run failed" },
    ]);
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
