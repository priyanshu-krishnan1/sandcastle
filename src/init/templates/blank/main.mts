import { run, bob, fyre } from "@ai-hero/sandcastle";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  agent: bob("default"),
  // Replace with your own SSH-reachable host.
  sandbox: fyre({ host: "your-host.example.com" }),
  promptFile: "./.sandcastle/prompt.md",
});
