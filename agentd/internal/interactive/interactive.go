// Package interactive runs a command attached to a pty (or plain pipes, when
// no pty is requested) and exposes it as a byte-stream session driven by the
// caller feeding in stdin/resize events and reading stdout/stderr/exit back.
package interactive

import (
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// StartOptions mirrors agentd.v1.InteractiveExecStart, decoupled from the
// generated protobuf type.
type StartOptions struct {
	Args []string
	Cwd  string
	Env  map[string]string
	Sudo bool
	Pty  bool
	Cols uint16
	Rows uint16
}

// ptyHandle is the subset of *os.File behavior a pty-backed session needs,
// plus resize — kept as an interface so Session doesn't otherwise depend on
// the pty package.
type ptyHandle interface {
	io.ReadWriteCloser
	Resize(cols, rows uint16) error
}

// Session is a running interactive command. All methods are safe to call
// concurrently with each other.
type Session struct {
	cmd    *exec.Cmd
	ptyFd  ptyHandle // non-nil only when Pty was requested
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

// Start launches the command described by s. When s.Pty is true, stdout and
// stderr are merged onto the single pty fd (a pty has one fd) — callers
// should treat all output as "stdout_chunk" in that mode, matching the wire
// protocol's documented behavior.
func Start(s StartOptions) (*Session, error) {
	args := s.Args
	if s.Sudo {
		args = append([]string{"sudo", "-n"}, args...)
	}
	cmd := exec.Command(args[0], args[1:]...)
	if s.Cwd != "" {
		cmd.Dir = s.Cwd
	}
	if len(s.Env) > 0 {
		env := cmd.Environ()
		for k, v := range s.Env {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}

	if s.Pty {
		f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: s.Cols, Rows: s.Rows})
		if err != nil {
			return nil, err
		}
		return &Session{cmd: cmd, ptyFd: ptyAdapter{f}, stdin: f, stdout: f}, nil
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Session{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

// Write sends stdin bytes to the session.
func (s *Session) Write(p []byte) (int, error) { return s.stdin.Write(p) }

// CloseStdin signals EOF on the session's stdin.
func (s *Session) CloseStdin() error { return s.stdin.Close() }

// Resize applies a terminal size change. A no-op when the session has no pty.
func (s *Session) Resize(cols, rows uint16) error {
	if s.ptyFd == nil {
		return nil
	}
	return s.ptyFd.Resize(cols, rows)
}

// Pump reads stdout/stderr until EOF, invoking onStdout/onStderr per chunk.
// When the session has a pty, all output arrives via onStdout, matching the
// wire protocol's documented single-fd behavior.
func (s *Session) Pump(onStdout, onStderr func([]byte)) {
	var wg sync.WaitGroup
	pumpOne := func(r io.Reader, sink func([]byte)) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				sink(chunk)
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(1)
	go pumpOne(s.stdout, onStdout)
	if s.stderr != nil {
		wg.Add(1)
		go pumpOne(s.stderr, onStderr)
	}
	wg.Wait()
}

// Wait blocks until the session's process exits and returns its exit code.
func (s *Session) Wait() int32 {
	err := s.cmd.Wait()
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return int32(exitErr.ExitCode())
	}
	return -1
}

// Close releases the session's pty/pipe file descriptors.
func (s *Session) Close() {
	if s.ptyFd != nil {
		_ = s.ptyFd.Close()
	}
}

type ptyAdapter struct{ f *os.File }

func (a ptyAdapter) Read(p []byte) (int, error)  { return a.f.Read(p) }
func (a ptyAdapter) Write(p []byte) (int, error) { return a.f.Write(p) }
func (a ptyAdapter) Close() error                { return a.f.Close() }
func (a ptyAdapter) Resize(cols, rows uint16) error {
	return pty.Setsize(a.f, &pty.Winsize{Cols: cols, Rows: rows})
}
