# Decoupling the sandbox lifecycle: GitClient, shared start/stop primitives, and adapter-per-file agents

## Context

Three independent duplication problems had built up in the sandbox lifecycle code:

1. **Git operations were hardcoded local `child_process.exec` calls, inlined directly
   in `SandboxLifecycle.ts`'s orchestration code** (`git rev-parse`, `git config`,
   `git merge`, `git branch -D`, `git rev-list`). There was no seam between "what git
   operation do we need" and "how does it actually run" — swapping in a different
   execution channel meant editing orchestration logic directly.
2. **The "create/reuse worktree → copy → run hooks → resolve git mounts → start
   sandbox" sequence was hand-rolled independently in three call sites**
   (`interactive.ts`, `createWorktree.ts`, `createSandbox.ts`), each branching on
   `sandboxProvider.tag` with its own near-identical `if`/`else if`/`else` chain.
   `SandboxFactory.ts`'s own `withSandbox` was a *fourth*, separate implementation of
   the same sequence, usable only as one scoped `Effect.acquireUseRelease` callback —
   not reusable from the other three.
3. **`SandboxHandle` was three structurally near-identical interfaces**
   (`BindMountSandboxHandle` / `IsolatedSandboxHandle` / `NoSandboxHandle`), differing
   only in whether file-transfer methods and `interactiveExec` were required —
   properties that are really per-provider-category facts, not distinct types.

Separately, `AgentProvider.ts` had grown into a single file holding both the shared
`AgentProvider` contract (interface, `ParsedStreamEvent`, `AgentSessionStorage`) *and*
bob's own factory, stream parsing, and task-id/usage extraction — with no structural
separation between "the seam" and "the one adapter plugged into it," unlike
`SandboxProvider`, where each concrete provider already lives in its own file under
`src/sandboxes/` (e.g. `src/sandboxes/fyre.ts`).

## Decision

**`GitClient.ts`** extracts every host-side git operation behind a `GitClientService`
interface, built by `makeGitClient(gitExec: GitExec)` against any function shaped
`(command, cwd) => Promise<{stdout}>`. `LocalGitClient` is `makeGitClient` fed the real
`child_process.exec`, reproducing the prior behavior exactly — per-operation failure
semantics (which calls die vs. degrade to a default vs. return a typed error) are
preserved 1:1 from what `SandboxLifecycle.ts` did before, not homogenized. This is the
only `GitClient` implementation Sandcastle ships; the `GitExec` parameterization exists
so a non-local implementation can be added later without changing
`GitClientService` or `SandboxLifecycle.ts`, but no such implementation exists today
(see "What we chose not to build" below).

**`SandboxFactory.ts`** gains three exported primitives — `acquireSandbox`,
`releaseSandbox`, `startSandboxAgainstTarget` — that `withSandbox` itself is now built
from (`Effect.acquireUseRelease(acquireSandbox(config), use, releaseSandbox)`).
`interactive.ts` and `createWorktree.ts` were migrated onto these, replacing their own
hand-rolled sequences. `createSandbox.ts`/`createSandboxFromWorktree` were **not**
migrated — they return a handle that outlives a single scoped callback and can run
multiple times, a shape `acquireSandbox`/`releaseSandbox` don't yet support. Both call
sites carry a comment explaining the gap rather than silently diverging.

**`SandboxProvider.ts`** collapses the three handle interfaces into one `SandboxHandle`
with an optional `transfer?: SandboxTransfer` field. The two call sites that read it
(`startSandbox.ts`, `syncOut.ts`) go through a new `requireTransfer(handle, context)`
helper rather than a bare `handle.transfer!` assertion, so a violated invariant (e.g. a
custom provider tagged `"isolated"` that forgot to implement `transfer`) surfaces as a
descriptive error naming the caller instead of a bare `undefined.copyIn is not a
function` crash.

**`src/agents/bob.ts`** holds bob's factory, stream parsing, and task-id/usage
extraction; `AgentProvider.ts` keeps only the shared `AgentProvider` interface and
`ParsedStreamEvent` type. This mirrors `src/sandboxes/fyre.ts` — `AgentProvider` is a
third pluggable seam (parallel to `SandboxProvider`: which agent CLI drives the work,
vs. what runs it in isolation), and a concrete provider belongs in its own file rather
than merged into the contract it implements.

## What we chose not to build

An earlier version of this branch also added `RepoRef.ts` (a `{local | remote | none}`
union for "where does a git repo live") and `SandcastleLifecycle.ts` (a lighter
`setup→beforeWork→work→afterWork→teardown` phase engine with `noGitLifecycle()` and
`remoteOnlyLifecycle()` presets), plus a `RemoteGitClient` SSH-backed `GitExec`. All
three had zero production callers — `RepoRef` was consumed only by `GitClient.ts`
(type-only) and `SandcastleLifecycle.ts`; `SandcastleLifecycle` was exercised only by
its own test file.

These were removed before merge. Designing an interface's shape ahead of a second real
use case means nothing pressure-tests whether the shape is actually right — a remote-git
`RepoRef` union and a five-phase lifecycle engine are exactly the kind of abstraction
that looks reasonable in isolation and turns out wrong once a real caller tries to use
it. `GitClient.ts` keeps its `GitExec` parameterization (the hook a non-local
implementation would plug into), so adding remote-repo support later doesn't require
re-deciding that part — but the `RepoRef` type, the dispatch logic, and the lifecycle
preset engine should be designed against whatever caller actually needs them, when one
exists.

`AgentProvider` has the same characteristic today: `bob` is Sandcastle's only shipped
adapter, so the `AgentProvider` contract — like `SandboxProvider` before it had `fyre`
and multiple sandbox categories — is not yet validated by a second real
implementation. That's noted here rather than treated as a reason to avoid the
adapter-per-file split, since the split itself (contract vs. one concrete provider)
is useful independent of how many providers exist; it's a reason not to add speculative
flexibility to the `AgentProvider` interface itself until a second adapter exists to
test it against.

## Consequences

- Git operations can be tested against an injected `GitExec`, and the same
  `GitClientService` contract works transparently once (if) a non-local implementation
  is added.
- `interactive.ts` and `createWorktree.ts` share one implementation of sandbox
  start/stop instead of three; `createSandbox.ts` remains a documented, intentional
  exception rather than an unexplained divergence.
- `SandboxHandle` consumers get a single type with a runtime-checked, clearly-diagnosed
  invariant instead of three near-duplicate interfaces with a silent one.
- `AgentProvider.ts` stays a small, stable contract as more agent adapters are added,
  each living in its own file under `src/agents/`, matching `src/sandboxes/`.
- Remote-repo support and lighter-weight (no-worktree) lifecycles are not implemented.
  Building them is future work, to be designed against a concrete caller rather than
  spliced back in from this branch's removed code.
