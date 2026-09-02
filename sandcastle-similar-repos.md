# Repos Similar to Sandcastle

Research into GitHub repos similar to [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle) — a TypeScript library that orchestrates AI coding agents (Claude Code, etc.) in isolated sandboxes (Docker/Podman/Vercel), using a git worktree/branch strategy with merge-back.

Organized by how similar the approach is.

## Tier 1 — Nearly identical concept

TS/programmatic SDK, provider-agnostic agent + sandbox pairing.

- [TwillAI/agentbox-sdk](https://github.com/TwillAI/agentbox-sdk) — the closest analog. Open-source TypeScript SDK, unified API, mix-and-match agents (Claude Code, OpenCode, Codex) with sandbox providers (local Docker, E2B, Modal, Daytona, Vercel).
- [dagger/container-use](https://github.com/dagger/container-use) — pairs each agent with a Dagger container + git branch; MCP-based so it plugs into Claude Code, Cursor, etc.
- [madarco/agentbox](https://github.com/madarco/agentbox) — runs multiple agents in parallel sandboxed VMs (local Docker or cloud via Hetzner/Daytona/Vercel/E2B).
- [rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent) — HTTP/SSE API for driving agents inside E2B, Daytona, Modal, or Docker.
- [intentic/intentic](https://github.com/intentic/intentic) — persistent Docker sandbox per agent plus its own git worktree, self-hosted.

## Tier 2 — Git-worktree / tmux multi-agent runners

CLI/TUI tools, not host-agnostic sandboxing, but same "parallel agents on branches" problem.

- [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) — the most popular one (~5k+ stars); manages Claude Code/Codex/Aider sessions via tmux + git worktrees.
- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) — Kanban-style board for planning + running 10+ coding agents in per-task workspaces, with PR creation built in.
- [andyrewlee/amux](https://github.com/andyrewlee/amux) — minimal TUI for spawning parallel agents in worktrees.
- [standardagents/dmux](https://github.com/standardagents/dmux) — dev-agent multiplexer pairing agents with worktrees over tmux.
- [spencermarx/orc](https://github.com/spencermarx/orc) — lightweight worktree + review framework.

## Tier 3 — Heavier orchestration frameworks

Multi-agent coordination on top of sandboxing.

- [sipyourdrink-ltd/bernstein](https://github.com/sipyourdrink-ltd/bernstein) — deterministic (non-LLM) scheduler for 40+ CLI coding agents, each task in its own git worktree behind merge gates.
- [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) — LangChain's async cloud coding agent, each task in an isolated cloud sandbox (Modal/Daytona/Runloop/E2B), Slack/Linear-driven.
- [OpenHands/OpenHands](https://github.com/OpenHands/openhands) — full autonomous software-engineering agent platform, self-hosted control center for coding agents.
- [maslennikov-ig/claude-code-orchestrator-kit](https://github.com/maslennikov-ig/claude-code-orchestrator-kit) — dispatches Claude Code "polecats" into isolated worktrees.
- [Yeachan-Heo/oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) — teams-first multi-agent orchestration layer for Claude Code.

## Tier 4 — Underlying sandbox infra

What Sandcastle-style tools plug _into_, not orchestrators themselves.

- [e2b-dev/e2b](https://github.com/e2b-dev/e2b) — Firecracker microVM sandboxes, JS/Python SDKs; likely the most-used general sandbox backend for these tools.
- Vercel Sandbox (`@vercel/sandbox`) — already one of Sandcastle's own built-in providers.
- Daytona's SDK is also a Sandcastle devDependency, but note: Daytona's core went closed-source in June 2026; its old open-source repo is archived/unmaintained.

## Closest single pick

[TwillAI/agentbox-sdk](https://github.com/TwillAI/agentbox-sdk) is the most direct sibling — same "TypeScript SDK, agent-agnostic, sandbox-provider-agnostic" design as Sandcastle. If you want something with more community traction/stars instead, [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) and [dagger/container-use](https://github.com/dagger/container-use) are the two most established projects solving the same "isolate the agent, merge back via git" problem.

## Sources

- [awesome-agent-orchestrators list](https://github.com/andyrewlee/awesome-agent-orchestrators)
- Individual repo pages linked above
