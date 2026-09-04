# agentd

Persistent per-host daemon that replaces per-exec SSH spawning for Fyre-backed
sandboxes. See [`docs/adr/0024-daemon-transport-for-fyre.md`](../docs/adr/0024-daemon-transport-for-fyre.md)
for why this exists and what it deliberately does not do.

This is a standalone Go module with its own build/release cadence — it has no
coupling to the npm package's build (`tsup`/`vitest` never touch it) and
`package.json`'s `"files": ["dist"]` allowlist already keeps it out of the
published npm tarball.

## Build

```bash
make proto   # regenerate gen/agentd/v1 from ../proto/agentd/v1/agentd.proto
make build   # go build ./...
make test    # go test ./... — the smoke-test suite in internal/server
```

Regenerating the proto stubs requires `protoc`, `protoc-gen-go`, and
`protoc-gen-go-grpc` on `PATH`:

```bash
brew install protobuf
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

## Local smoke testing

`scripts/gen-dev-ca.sh` generates a throwaway CA + server/client cert pair for
local use (requires `openssl` on `PATH`):

```bash
./scripts/gen-dev-ca.sh
go run ./cmd/agentd \
  -listen :8443 \
  -server-cert dev-certs/server-cert.pem \
  -server-key dev-certs/server-key.pem \
  -client-ca dev-certs/ca-cert.pem
```

From another terminal, `grpcurl` (with a client cert) can exercise it directly
against `proto/agentd/v1/agentd.proto`, or run `make test` for the automated
suite, which generates its own throwaway certs per test run (no dependency on
`gen-dev-ca.sh` or `openssl`).

## Fleet mTLS bootstrap (real deployment)

Certificate issuance is intentionally a one-time, manual bootstrap — not an
automated enrollment protocol (see ADR-0024's "what we chose not to build").
For each Fyre VM:

1. Generate a project-local CA once (keep the CA key offline, not on any Fyre
   VM) — this is the production analogue of `gen-dev-ca.sh`'s CA step, done
   once for the whole fleet rather than per host.
2. Issue one server certificate per VM, `CN=<hostname>`, signed by that CA.
3. Issue one client certificate for the machine(s) running `sandcastle`
   (i.e. wherever `remoteDaemon()`/`remoteDaemonNative()` connect from).
4. Copy the `agentd` binary, that VM's server cert/key, and the CA cert onto
   the VM over the SSH access `fyre.ts` already uses today, and start it
   (e.g. via a systemd unit — not included here; write one appropriate to
   your fleet's init system) with:

   ```
   agentd -listen :8443 \
     -server-cert /etc/agentd/server-cert.pem \
     -server-key /etc/agentd/server-key.pem \
     -client-ca /etc/agentd/ca-cert.pem
   ```

Any client presenting a certificate signed by the project CA is trusted —
there is no per-client ACL (a deliberate scope decision for the current
single-tenant operational model; see ADR-0024).

## Package layout

```
cmd/agentd/          entrypoint: flags, TLS config, graceful shutdown
internal/server/     AgentDaemonServer implementation + mTLS config
internal/exec/       non-interactive exec: process spawn, line streaming,
                      process-group cancellation
internal/interactive/ pty/pipe-backed interactive sessions
internal/transfer/   CopyIn/CopyOut: hash-verify-then-atomically-place
internal/health/     load/activity snapshot for the Health RPC
internal/config/     runtime configuration
gen/agentd/v1/       generated protobuf/gRPC stubs (checked in — no protoc
                     toolchain needed to build agentd from a clean checkout)
```
