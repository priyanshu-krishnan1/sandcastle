import { describe, expect, it } from "vitest";
import { bob } from "./bob.js";
import type { ParsedStreamEvent } from "../AgentProvider.js";

/**
 * Fixture-based end-to-end regression coverage for the bob() Bob-Shell 2.0
 * `parseStreamLine` implementation.
 *
 * The unit tests in bob.test.ts check "does event X map to Y" in
 * isolation, one line at a time. That style of test cannot catch a bug that
 * only shows up when a *sequence* of realistic events is replayed through the
 * full pipeline — e.g. whether a tool call whose `parameters`/`output` happen
 * to contain the literal completion-signal string ever leaks into
 * Orchestrator.ts's `accumulatedOutput` once a whole transcript plays out,
 * not just a single line.
 *
 * This file replays recorded-looking `stream-json` transcripts (arrays of raw
 * JSON lines) through the REAL, imported `bob("default").parseStreamLine`
 * (never reimplemented) and mirrors — not reimplements the intent of, but
 * copies verbatim — the exact accumulation logic from Orchestrator.ts's
 * `invokeAgent` (see src/Orchestrator.ts's onLine handler):
 *
 *   for (const parsed of provider.parseStreamLine(line)) {
 *     if (parsed.type === "text") {
 *       if (parsed.assertive !== false) accumulatedOutput += parsed.text;
 *     } else if (parsed.type === "result") {
 *       accumulatedOutput += parsed.result;
 *     }
 *     // tool_call / session_id / usage events never touch accumulatedOutput
 *   }
 *   const found = completionSignals.find((sig) => accumulatedOutput.includes(sig));
 *
 * Orchestrator.ts does not export `invokeAgent` (or the accumulation logic)
 * for reuse, so per the task this is intentionally re-inlined here as a small
 * harness rather than imported.
 */

const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

/** Mirrors Orchestrator.ts's invokeAgent accumulation logic exactly (see file header). */
const replayTranscript = (
  provider: { parseStreamLine(line: string): ParsedStreamEvent[] },
  lines: readonly string[],
): { accumulatedOutput: string; allEvents: ParsedStreamEvent[] } => {
  let accumulatedOutput = "";
  const allEvents: ParsedStreamEvent[] = [];

  for (const line of lines) {
    for (const parsed of provider.parseStreamLine(line)) {
      allEvents.push(parsed);
      if (parsed.type === "text") {
        if (parsed.assertive !== false) {
          accumulatedOutput += parsed.text;
        }
      } else if (parsed.type === "result") {
        accumulatedOutput += parsed.result;
      }
      // tool_call / session_id / usage events deliberately never touch
      // accumulatedOutput, exactly as in Orchestrator.ts.
    }
  }

  return { accumulatedOutput, allEvents };
};

// ---------------------------------------------------------------------------
// Fixture 1: completion signal embedded ONLY inside tool calls (a file-write
// payload and a grep result) — must never leak into accumulatedOutput.
// ---------------------------------------------------------------------------

const transcriptSignalOnlyInToolCalls: string[] = [
  // Reasoning commentary — surfaced as non-assertive text, never reaches
  // accumulatedOutput (see fixture 4 below for the case where this content
  // itself contains the literal signal).
  JSON.stringify({
    type: "message",
    role: "assistant",
    isReasoning: true,
    content: "I'll write the promise doc and then grep for it to confirm.",
  }),
  // A Write tool call whose parameters embed the literal completion signal
  // string as file content being authored — NOT the agent asserting it.
  JSON.stringify({
    type: "tool_use",
    tool_name: "Write",
    tool_id: "t1",
    parameters: {
      path: "docs/PROMISE_FORMAT.md",
      content:
        "The agent must emit the literal string <promise>COMPLETE</promise> when finished.",
    },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "t1",
    status: "success",
    output: "wrote docs/PROMISE_FORMAT.md",
  }),
  // A Grep tool call searching for the marker, whose *output* echoes the
  // matched line back — again, not the agent's own assertion.
  JSON.stringify({
    type: "tool_use",
    tool_name: "Grep",
    tool_id: "t2",
    parameters: { pattern: "<promise>COMPLETE</promise>", path: "docs/" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "t2",
    status: "success",
    output: "docs/PROMISE_FORMAT.md:1:<promise>COMPLETE</promise>",
  }),
  // A genuine final assistant message that explicitly does NOT contain the
  // completion signal.
  JSON.stringify({
    type: "message",
    role: "assistant",
    content:
      "I've documented the promise format and verified the grep matches it. Still need to wire up the emitter next.",
  }),
  // Bare success result — no text content, only stats. Must not fabricate
  // the signal (see the existing unit test for this same guard).
  JSON.stringify({
    type: "result",
    status: "success",
    stats: { turns: 5, input_tokens: 120, output_tokens: 80 },
  }),
];

// ---------------------------------------------------------------------------
// Fixture 2: true-positive control — the signal appears in a genuine final
// assistant message (and in the terminal result's last_message). Without
// this, a parser that dropped the signal unconditionally would pass fixture 1
// vacuously.
// ---------------------------------------------------------------------------

const transcriptGenuineCompletion: string[] = [
  // Reasoning commentary — surfaced as non-assertive text (see fixture 4),
  // must not itself be mistaken for the genuine completion below.
  JSON.stringify({
    type: "message",
    role: "assistant",
    isReasoning: true,
    content: "Let me run the tests one more time before wrapping up.",
  }),
  JSON.stringify({
    type: "tool_use",
    tool_name: "Bash",
    tool_id: "t1",
    parameters: { command: "npm test" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "t1",
    status: "success",
    output: "42 passed, 0 failed",
  }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content:
      "All tests pass and the feature is fully implemented. <promise>COMPLETE</promise>",
  }),
  JSON.stringify({
    type: "result",
    status: "success",
    last_message:
      "All tests pass and the feature is fully implemented. <promise>COMPLETE</promise>",
    stats: { turns: 6, input_tokens: 500, output_tokens: 300 },
  }),
];

// ---------------------------------------------------------------------------
// Fixture 3: error path mid-stream — a failed tool_result followed by a
// terminal {"type":"result","status":"error"} event. Neither may ever surface
// as a bare {type:"text"} event (both route through tool_call), per the
// design already implemented in bob.ts.
// ---------------------------------------------------------------------------

const transcriptMidStreamError: string[] = [
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Trying to run the deploy script now.",
  }),
  JSON.stringify({
    type: "tool_use",
    tool_name: "Bash",
    tool_id: "t1",
    parameters: { command: "./deploy.sh" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "t1",
    status: "error",
    error: "deploy.sh: command not found",
  }),
  JSON.stringify({
    type: "result",
    status: "error",
    error: "bob crashed while executing the plan",
  }),
];

// ---------------------------------------------------------------------------
// Fixture 4: the completion signal appears ONLY inside reasoning commentary
// (isReasoning: true) — the exact scenario `assertive: false` exists for.
// The reasoning event must still be visible in allEvents as text (so the
// user sees it), but must never reach accumulatedOutput.
// ---------------------------------------------------------------------------

const transcriptSignalOnlyInReasoning: string[] = [
  JSON.stringify({
    type: "message",
    role: "assistant",
    isReasoning: true,
    content:
      "Once everything passes I'll emit <promise>COMPLETE</promise> to finish up.",
  }),
  JSON.stringify({
    type: "tool_use",
    tool_name: "Bash",
    tool_id: "t1",
    parameters: { command: "npm test" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "t1",
    status: "success",
    output: "3 passed, 1 failed",
  }),
  // Genuine final assistant message — deliberately does NOT contain the
  // signal, since the task isn't actually done yet (one test still fails).
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "One test is still failing — investigating before I finish.",
  }),
];

describe("bob() Bob-Shell 2.0 fixture-based regression coverage (full-pipeline replay)", () => {
  it("never leaks a completion signal embedded only inside tool_use/tool_result payloads into accumulatedOutput", () => {
    const provider = bob("default");
    const { accumulatedOutput } = replayTranscript(
      provider,
      transcriptSignalOnlyInToolCalls,
    );

    expect(accumulatedOutput).not.toContain(COMPLETION_SIGNAL);
  });

  it("true-positive control: DOES find the completion signal when a genuine final assistant message asserts it", () => {
    const provider = bob("default");
    const { accumulatedOutput } = replayTranscript(
      provider,
      transcriptGenuineCompletion,
    );

    expect(accumulatedOutput).toContain(COMPLETION_SIGNAL);
  });

  it("never emits a bare {type:'text'} event for a mid-stream tool_result error or a terminal result error", () => {
    const provider = bob("default");
    const { allEvents } = replayTranscript(provider, transcriptMidStreamError);

    // The two error-carrying events must both be routed through tool_call.
    expect(allEvents).toContainEqual({
      type: "tool_call",
      name: "tool_result",
      args: "deploy.sh: command not found",
    });
    expect(allEvents).toContainEqual({
      type: "tool_call",
      name: "error",
      args: "bob crashed while executing the plan",
    });

    // No event derived from either error carries its message as bare text.
    const textEvents = allEvents.filter(
      (e): e is Extract<ParsedStreamEvent, { type: "text" }> =>
        e.type === "text",
    );
    for (const e of textEvents) {
      expect(e.text).not.toContain("command not found");
      expect(e.text).not.toContain("bob crashed");
    }
  });

  it("never leaks a completion signal embedded only inside reasoning commentary into accumulatedOutput, while still surfacing it as visible text", () => {
    const provider = bob("default");
    const { accumulatedOutput, allEvents } = replayTranscript(
      provider,
      transcriptSignalOnlyInReasoning,
    );

    // The false-positive this fixture guards against: the signal must never
    // reach the completion-signal-eligible buffer.
    expect(accumulatedOutput).not.toContain(COMPLETION_SIGNAL);

    // But the reasoning content must still be visible to the user — dropped
    // entirely would be a regression to the pre-`assertive` behavior.
    expect(allEvents).toContainEqual({
      type: "text",
      text: "Once everything passes I'll emit <promise>COMPLETE</promise> to finish up.",
      assertive: false,
    });
  });
});
