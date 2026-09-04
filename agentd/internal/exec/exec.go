// Package exec runs a single shell command as a fresh child process and
// streams its stdout/stderr back line-by-line. This is the daemon-side half
// of the SandboxHandle.exec contract in src/SandboxProvider.ts, which
// requires line-streamed output — src/Orchestrator.ts resets an idle-timeout
// deferred on every line, so no batching is allowed anywhere in this path.
package exec

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Request mirrors agentd.v1.ExecRequest, decoupled from the generated
// protobuf type so this package has no dependency on the wire format.
type Request struct {
	Command string
	Cwd     string
	Sudo    bool
	Env     map[string]string
	Stdin   *string
}

// LineEvent is one line of output from either stream, delivered as soon as
// it is read — never batched.
type LineEvent struct {
	Stream string // "stdout" or "stderr"
	Line   string
	Seq    int64
}

// Result is the terminal outcome of a Run call.
type Result struct {
	ExitCode int32
}

// gracePeriod is how long a cancelled process group is given to exit after
// SIGTERM before the daemon escalates to SIGKILL.
const gracePeriod = 3 * time.Second

// Run executes req as `sh -c command`, delivering each output line to onLine
// as soon as it is scanned, and returns once the process exits or ctx is
// cancelled. On cancellation, Run signals the whole process group (not just
// the direct child) since Command may itself spawn further children — SSH
// gets this for free via session teardown; a long-lived daemon must do it
// explicitly.
func Run(ctx context.Context, req Request, onLine func(LineEvent)) (Result, error) {
	shellCmd := req.Command
	if req.Sudo {
		shellCmd = "sudo -n " + shellCmd
	}

	cmd := exec.Command("sh", "-c", shellCmd)
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}
	if len(req.Env) > 0 {
		env := cmd.Environ()
		for k, v := range req.Env {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}
	setProcessGroup(cmd)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, fmt.Errorf("exec: stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return Result{}, fmt.Errorf("exec: stderr pipe: %w", err)
	}
	if req.Stdin != nil {
		cmd.Stdin = strings.NewReader(*req.Stdin)
	}

	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("exec: start: %w", err)
	}

	var seq int64
	nextSeq := func() int64 { return atomic.AddInt64(&seq, 1) }

	var wg sync.WaitGroup
	wg.Add(2)
	go streamLines(&wg, stdoutPipe, "stdout", nextSeq, onLine)
	go streamLines(&wg, stderrPipe, "stderr", nextSeq, onLine)

	waitDone := make(chan error, 1)
	go func() {
		wg.Wait() // drain both pipes before Wait(), matching exec.Cmd's contract
		waitDone <- cmd.Wait()
	}()

	select {
	case waitErr := <-waitDone:
		return Result{ExitCode: exitCodeOf(waitErr)}, nil
	case <-ctx.Done():
		// waitDone is read exactly once below, regardless of which branch
		// fires — killProcessGroup must never itself read from it, or the
		// second read here would block forever on an already-drained,
		// single-buffered channel.
		pgid := cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		select {
		case <-waitDone:
		case <-time.After(gracePeriod):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			<-waitDone
		}
		return Result{}, ctx.Err()
	}
}

func streamLines(wg *sync.WaitGroup, r io.Reader, stream string, nextSeq func() int64, onLine func(LineEvent)) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		onLine(LineEvent{Stream: stream, Line: scanner.Text(), Seq: nextSeq()})
	}
}

func exitCodeOf(err error) int32 {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if ok := asExitError(err, &exitErr); ok {
		return int32(exitErr.ExitCode())
	}
	return -1
}

func asExitError(err error, target **exec.ExitError) bool {
	if ee, ok := err.(*exec.ExitError); ok {
		*target = ee
		return true
	}
	return false
}
