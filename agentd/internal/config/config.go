// Package config holds agentd's runtime configuration.
package config

// Config is the daemon's runtime configuration, populated from flags in
// cmd/agentd/main.go.
type Config struct {
	// ListenAddr is the TCP address to bind, e.g. ":8443".
	ListenAddr string
	// ServerCertFile/ServerKeyFile are this host's TLS identity.
	ServerCertFile string
	ServerKeyFile  string
	// ClientCAFile is the project CA used to verify client certificates —
	// only a client presenting a cert signed by this CA is accepted.
	ClientCAFile string
	// DefaultCwd is used for an ExecRequest with no cwd set — normally the
	// sandbox worktree root.
	DefaultCwd string
	// MaxConcurrentExecs is a coarse host-resource safety net, not a
	// scheduler: exceeding it fails a new Exec/InteractiveExec immediately
	// with RESOURCE_EXHAUSTED rather than queuing it. Concurrency limiting
	// across many sandboxes/agents stays the caller's responsibility (see
	// docs/adr/0024-daemon-transport-for-fyre.md).
	MaxConcurrentExecs int
}

// Default returns a Config with reasonable defaults for MaxConcurrentExecs;
// all other fields must be set by the caller.
func Default() Config {
	return Config{MaxConcurrentExecs: 256}
}
