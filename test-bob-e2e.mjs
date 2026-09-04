#!/usr/bin/env node
/**
 * End-to-end test for Bob-Shell agent provider
 * This test verifies the integration works correctly
 */

import { bob } from "./dist/index.js";

console.log("=== Bob-Shell Agent Provider E2E Test ===\n");

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    testsFailed++;
  }
}

// Test 1: Basic agent creation
test("Create Bob agent with default model", () => {
  const agent = bob("default");
  if (agent.name !== "bob") throw new Error("Agent name should be 'bob'");
  if (agent.captureSessions !== false)
    throw new Error("Should not capture sessions");
});

// Test 2: Agent creation with options
test("Create Bob agent with custom options", () => {
  const agent = bob("gpt-4", {
    model: "custom-model",
    env: { BOB_API_KEY: "test-key", CUSTOM_VAR: "value" },
  });
  if (!agent.env.BOB_API_KEY) throw new Error("API key not set");
  if (!agent.env.CUSTOM_VAR) throw new Error("Custom env var not set");
});

// Test 3: buildPrintCommand basic
test("buildPrintCommand generates correct command", () => {
  const agent = bob("default");
  const cmd = agent.buildPrintCommand({
    prompt: "Test prompt",
    dangerouslySkipPermissions: false,
  });
  if (!cmd.command.includes("bob"))
    throw new Error("Command should include 'bob'");
  if (cmd.stdin !== "Test prompt")
    throw new Error("Stdin should contain prompt");
});

// Test 4: buildPrintCommand with model option
// Note: Bob 2.0's `bob run` has no `--model` flag — the `model` option is
// rendered as `--mode` instead (see BobOptions doc comment in AgentProvider.ts).
test("buildPrintCommand includes mode flag", () => {
  const agent = bob("default", { model: "custom-model" });
  const cmd = agent.buildPrintCommand({
    prompt: "Test",
    dangerouslySkipPermissions: false,
  });
  if (!cmd.command.includes("--mode"))
    throw new Error("Should include --mode flag");
  if (!cmd.command.includes("custom-model"))
    throw new Error("Should include model name");
});

// Test 5: buildInteractiveArgs basic
test("buildInteractiveArgs generates correct args", () => {
  const agent = bob("default");
  const args = agent.buildInteractiveArgs({
    prompt: "Test prompt",
    dangerouslySkipPermissions: false,
  });
  if (args[0] !== "bob") throw new Error("First arg should be 'bob'");
  if (!args.includes("Test prompt")) throw new Error("Should include prompt");
});

// Test 6: buildInteractiveArgs with model
// Note: same --mode-not-model correction as the buildPrintCommand test above.
test("buildInteractiveArgs includes mode", () => {
  const agent = bob("default", { model: "test-model" });
  const args = agent.buildInteractiveArgs({
    prompt: "Test",
    dangerouslySkipPermissions: false,
  });
  if (!args.includes("--mode")) throw new Error("Should include --mode flag");
  if (!args.includes("test-model"))
    throw new Error("Should include model name");
});

// Test 7: parseStreamLine - plain text
test("parseStreamLine handles plain text", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine("This is plain text output");
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "text") throw new Error("Should be text event");
  if (events[0].text !== "This is plain text output")
    throw new Error("Text content mismatch");
});

// Test 8: parseStreamLine - JSON text event
test("parseStreamLine handles JSON text event", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine('{"type":"text","text":"JSON output"}');
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "text") throw new Error("Should be text event");
  if (events[0].text !== "JSON output")
    throw new Error("Text content mismatch");
});

// Test 9: parseStreamLine - JSON tool_call event
test("parseStreamLine handles JSON tool_call event", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine(
    '{"type":"tool_call","name":"Bash","args":"ls -la"}',
  );
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "tool_call")
    throw new Error("Should be tool_call event");
  if (events[0].name !== "Bash") throw new Error("Tool name mismatch");
  if (events[0].args !== "ls -la") throw new Error("Tool args mismatch");
});

// Test 10: parseStreamLine - JSON result event
test("parseStreamLine handles JSON result event", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine(
    '{"type":"result","result":"Task completed"}',
  );
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "result") throw new Error("Should be result event");
  if (events[0].result !== "Task completed")
    throw new Error("Result content mismatch");
});

// Test 11: parseStreamLine - JSON session_id event
test("parseStreamLine handles JSON session_id event", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine(
    '{"type":"session_id","sessionId":"abc-123"}',
  );
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "session_id")
    throw new Error("Should be session_id event");
  if (events[0].sessionId !== "abc-123") throw new Error("Session ID mismatch");
});

// Test 12: parseStreamLine - invalid JSON falls back to text
test("parseStreamLine handles invalid JSON as text", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine('{"invalid json');
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "text")
    throw new Error("Should fall back to text event");
});

// Test 13: parseStreamLine - empty line
test("parseStreamLine handles empty line", () => {
  const agent = bob("default");
  const events = agent.parseStreamLine("");
  if (events.length !== 1) throw new Error("Should return 1 event");
  if (events[0].type !== "text") throw new Error("Should be text event");
});

// Test 14: Environment variable merging
test("Environment variables are properly merged", () => {
  const agent = bob("default", {
    env: { VAR1: "value1", VAR2: "value2" },
  });
  if (Object.keys(agent.env).length !== 2)
    throw new Error("Should have 2 env vars");
  if (agent.env.VAR1 !== "value1") throw new Error("VAR1 mismatch");
  if (agent.env.VAR2 !== "value2") throw new Error("VAR2 mismatch");
});

// Test 15: Shell escaping in commands
test("Shell escaping works correctly", () => {
  const agent = bob("default", { model: "model'with'quotes" });
  const cmd = agent.buildPrintCommand({
    prompt: "Test",
    dangerouslySkipPermissions: false,
  });
  // Should escape single quotes properly
  if (!cmd.command.includes("'model'\\''with'\\''quotes'")) {
    throw new Error("Shell escaping not working correctly");
  }
});

console.log("\n=== Test Results ===");
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
  console.log("\n❌ Some tests failed");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
  console.log(
    "\nNote: These tests verify the TypeScript/JavaScript integration.",
  );
  console.log("To fully test Bob-Shell integration, you need to:");
  console.log("1. Install Bob-Shell in a Docker container");
  console.log("2. Run an actual sandcastle.run() with bob() agent");
  console.log("3. Verify Bob's output format matches the parsing logic");
}
