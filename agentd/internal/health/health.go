// Package health tracks the daemon's own point-in-time load, exposed via the
// Health RPC. No component in this codebase consumes it yet — see
// docs/adr/0024-daemon-transport-for-fyre.md, "what we chose not to build".
// It exists purely so a future consumer wouldn't force a wire-format change.
package health

import (
	"sync/atomic"
	"time"
)

// Version is the daemon's build version, set at link time via
// -ldflags "-X .../health.Version=...". Defaults to "dev".
var Version = "dev"

// Tracker holds atomically-updated counters for in-flight work.
type Tracker struct {
	activeExec        int64
	activeInteractive int64
	startedAt         time.Time
}

// NewTracker returns a Tracker whose uptime is measured from now.
func NewTracker() *Tracker {
	return &Tracker{startedAt: time.Now()}
}

// BeginExec/EndExec bracket one non-interactive exec's lifetime.
func (t *Tracker) BeginExec() { atomic.AddInt64(&t.activeExec, 1) }
func (t *Tracker) EndExec()   { atomic.AddInt64(&t.activeExec, -1) }

// BeginInteractive/EndInteractive bracket one interactive session's lifetime.
func (t *Tracker) BeginInteractive() { atomic.AddInt64(&t.activeInteractive, 1) }
func (t *Tracker) EndInteractive()   { atomic.AddInt64(&t.activeInteractive, -1) }

// Snapshot is a point-in-time read of the tracker plus host load, decoupled
// from the generated protobuf HealthResponse type.
type Snapshot struct {
	ActiveExecCount        int32
	ActiveInteractiveCount int32
	QueueDepth             int32 // always 0 in v1 — the daemon does not queue
	Load1                  float64
	UptimeSeconds          uint64
	DaemonVersion          string
}

// Snapshot reads the current counters and host load average.
func (t *Tracker) Snapshot() Snapshot {
	return Snapshot{
		ActiveExecCount:        int32(atomic.LoadInt64(&t.activeExec)),
		ActiveInteractiveCount: int32(atomic.LoadInt64(&t.activeInteractive)),
		QueueDepth:             0,
		Load1:                  loadAvg1(),
		UptimeSeconds:          uint64(time.Since(t.startedAt).Seconds()),
		DaemonVersion:          Version,
	}
}
