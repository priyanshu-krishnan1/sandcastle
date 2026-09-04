<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png">
    <img alt="Sandcastle" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## What is Sandcastle?

Sandcastle is a TypeScript library (`@ai-hero/sandcastle`) for running an AI coding agent against a git repository inside a sandbox, then bringing the commits it makes back to your repo.

```typescript
import { run, bob, fyre } from "@ai-hero/sandcastle";

await run({
  agent: bob("default"),
  sandbox: fyre({ host: "my-host.example.com" }),
  promptFile: ".sandcastle/prompt.md",
});
```

`run()` creates a git worktree, starts a sandbox, invokes the agent (up to `maxIterations` times, stopping early if it signals completion), and merges or collects the commits it made.

## Install

```bash
npm install --save-dev @ai-hero/sandcastle
```

## Quick start

```bash
npx @ai-hero/sandcastle init
```

This scaffolds a `.sandcastle/` directory (image file, `.env.example`, a `main.ts`/`main.mts` script, and a prompt file) based on a template you pick. Fill in `.sandcastle/.env` — copy `.env.example` and set `BOB_API_KEY` — then run it:

```bash
npx tsx .sandcastle/main.ts
```

## Core pieces

- **Agent provider** (`agent` option) — builds the command that invokes an AI coding CLI and parses its output. The only one Sandcastle ships is `bob`, which wraps IBM's Bob-Shell CLI. Implement the `AgentProvider` interface to add another.
- **Sandbox provider** (`sandbox` option) — creates and manages the environment the agent runs in. Built in: `fyre`/`fyreNative` (SSH), `remoteDaemon`/`remoteDaemonNative` (mTLS gRPC to an `agentd` daemon), and `noSandbox` (runs directly on the host, no isolation). `createBindMountSandboxProvider`/`createIsolatedSandboxProvider` build your own.
- **Branch strategy** (`branchStrategy` option) — `head` (agent writes directly into the host's working directory), `merge-to-head` (temp branch, merged back, deleted), or `branch` (an explicit named branch).
- **Iteration** — one invocation of the agent inside the sandbox. `run()` stops early once the agent's own text contains a completion signal (default `<promise>COMPLETE</promise>`).

See the full reference in [`docs/`](docs/content/docs) (a local Fumadocs site — `cd docs && npm install && npm run dev`), or read the pages directly:

- [Getting Started](docs/content/docs/index.mdx)
- [Configuration](docs/content/docs/configuration.mdx) — the `.sandcastle/` directory, environment variables, prompt file syntax.
- [Sandbox Providers](docs/content/docs/sandbox-providers.mdx)
- [Agent Providers](docs/content/docs/agent-providers.mdx)
- [API Reference](docs/content/docs/api-reference.mdx) — `run()`, `interactive()`, `createSandbox()`, `createWorktree()`, structured output, errors.

For the vocabulary used throughout the codebase (sandbox vs. host, branch strategies, iteration vs. task, session resume vs. fork, etc.), see [`CONTEXT.md`](CONTEXT.md).

## CLI

The `sandcastle` CLI has one subcommand: `init` (scaffolds `.sandcastle/`). Everything else — running the agent, custom orchestration — is the library API, called from your own script.

```
sandcastle init [--template <name>] [--model <name>] [--sandbox <docker|podman>]
                 [--issue-tracker <github-issues|beads|custom>]
                 [--create-label <true|false>] [--install-template-deps <true|false>]
```

Flags are prompted for interactively when omitted (requires a TTY); non-interactive invocations must pass every flag.

## Development

```bash
npm install
npm run build         # bundle with tsup
npm test               # unit tests (vitest)
npm run test:integration
npm run typecheck
npm run format
```

## License

MIT
