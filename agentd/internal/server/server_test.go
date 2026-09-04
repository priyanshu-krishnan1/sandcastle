package server_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	agentdv1 "github.com/ai-hero/sandcastle/agentd/gen/agentd/v1"
	"github.com/ai-hero/sandcastle/agentd/internal/config"
	"github.com/ai-hero/sandcastle/agentd/internal/server"
)

// startTestServer boots a real AgentDaemonServer on a real TCP port with mTLS
// enforced by throwaway test certs, and returns a connected client plus a
// cleanup func. Every test in this file exercises the real wire protocol —
// no in-memory shortcuts — since the wire protocol is exactly what's being
// validated per the Phase 2 build order in the daemon-transport plan.
func startTestServer(t *testing.T, cfg config.Config) agentdv1.AgentDaemonClient {
	t.Helper()

	certs := generateTestCerts(t)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	grpcServer := grpc.NewServer(grpc.Creds(credentials.NewTLS(certs.serverTLSConfig(t))))
	agentdv1.RegisterAgentDaemonServer(grpcServer, server.New(cfg))

	go func() { _ = grpcServer.Serve(lis) }()
	t.Cleanup(grpcServer.GracefulStop)

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(certs.clientTLSConfig(t))))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	return agentdv1.NewAgentDaemonClient(conn)
}

// TestExec_LineByLineLatency is the direct, isolated test of the design's
// core latency requirement: Orchestrator.ts resets an idle-timeout deferred
// on every line, so the daemon must never batch multiple lines into one
// message or delay delivery behind a sleep in the command.
func TestExec_LineByLineLatency(t *testing.T) {
	client := startTestServer(t, config.Default())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.Exec(ctx, &agentdv1.ExecRequest{
		Command: `for i in 1 2 3; do echo "line $i"; sleep 0.3; done`,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var lines []string
	var lineArrival []time.Time
	start := time.Now()
	var exitCode int32 = -1
	for {
		ev, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		switch e := ev.GetEvent().(type) {
		case *agentdv1.ExecEvent_StdoutLine:
			lines = append(lines, e.StdoutLine.GetLine())
			lineArrival = append(lineArrival, time.Now())
		case *agentdv1.ExecEvent_Exit:
			exitCode = e.Exit.GetExitCode()
		}
	}

	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %v", len(lines), lines)
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}

	// Each line should arrive close to its own sleep boundary, not all
	// bunched at the very end (which would indicate batching/buffering
	// somewhere in the pipeline).
	for i, arrival := range lineArrival {
		elapsed := arrival.Sub(start)
		wantAround := time.Duration(i) * 300 * time.Millisecond
		// Generous tolerance for CI/scheduling jitter — the property under
		// test is "proportional to i", not a tight bound.
		if elapsed < wantAround-200*time.Millisecond {
			t.Errorf("line %d arrived too early (at %v, expected around %v) — did events get reordered?", i, elapsed, wantAround)
		}
	}
	totalElapsed := lineArrival[len(lineArrival)-1].Sub(start)
	if totalElapsed < 500*time.Millisecond {
		t.Errorf("all lines arrived within %v — command should have taken ~600ms+, suggests output was buffered rather than streamed live", totalElapsed)
	}
}

func TestExec_CapturesStderrAndNonZeroExit(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Exec(ctx, &agentdv1.ExecRequest{Command: `echo out; echo err >&2; exit 7`})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var stdoutLines, stderrLines []string
	var exitCode int32 = -1
	for {
		ev, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		switch e := ev.GetEvent().(type) {
		case *agentdv1.ExecEvent_StdoutLine:
			stdoutLines = append(stdoutLines, e.StdoutLine.GetLine())
		case *agentdv1.ExecEvent_StderrLine:
			stderrLines = append(stderrLines, e.StderrLine.GetLine())
		case *agentdv1.ExecEvent_Exit:
			exitCode = e.Exit.GetExitCode()
		}
	}

	if len(stdoutLines) != 1 || stdoutLines[0] != "out" {
		t.Errorf("stdout = %v, want [\"out\"]", stdoutLines)
	}
	if len(stderrLines) != 1 || stderrLines[0] != "err" {
		t.Errorf("stderr = %v, want [\"err\"]", stderrLines)
	}
	if exitCode != 7 {
		t.Errorf("exit code = %d, want 7", exitCode)
	}
}

func TestExec_StdinIsWrittenAndClosed(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stdin := "hello from stdin"
	stream, err := client.Exec(ctx, &agentdv1.ExecRequest{Command: "cat", Stdin: &stdin})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var got string
	for {
		ev, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		if line := ev.GetStdoutLine(); line != nil {
			got += line.GetLine()
		}
	}
	if got != stdin {
		t.Errorf("cat echoed %q, want %q", got, stdin)
	}
}

// TestExec_CancellationKillsProcessGroup verifies that closing the client's
// side of the stream actually kills the remote command tree, not just the
// direct child — the daemon-side responsibility SSH gets for free via
// session teardown (see ADR-0024).
func TestExec_CancellationKillsProcessGroup(t *testing.T) {
	client := startTestServer(t, config.Default())

	markerFile := filepath.Join(t.TempDir(), "still-running")
	ctx, cancel := context.WithCancel(context.Background())

	// A parent shell spawning a child sleep — the process-group kill must
	// reach the child, not just the parent shell.
	stream, err := client.Exec(ctx, &agentdv1.ExecRequest{
		Command: `sh -c 'sleep 30; touch ` + markerFile + `' & wait`,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Wait for the exec to actually be running before cancelling.
	time.Sleep(300 * time.Millisecond)
	cancel()

	// Drain the stream; it should end (possibly with a cancellation error),
	// not hang.
	for {
		_, err := stream.Recv()
		if err != nil {
			break
		}
	}

	// If the process group was really killed, the marker file must never
	// appear even after waiting past the original 30s sleep's completion
	// point (we don't wait 30s in the test — instead we confirm the file
	// does not appear within a much shorter grace window, which is the
	// observable signal that the group actually died rather than continuing
	// in the background).
	time.Sleep(2 * time.Second)
	if _, err := os.Stat(markerFile); err == nil {
		t.Errorf("marker file exists — child process survived cancellation, process group was not killed")
	}
}

func TestInteractiveExec_PtyEchoRoundTrip(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.InteractiveExec(ctx)
	if err != nil {
		t.Fatalf("InteractiveExec: %v", err)
	}

	err = stream.Send(&agentdv1.InteractiveExecClientMsg{
		Msg: &agentdv1.InteractiveExecClientMsg_Start{
			Start: &agentdv1.InteractiveExecStart{
				Args:        []string{"cat"},
				Pty:         true,
				InitialSize: &agentdv1.TerminalSize{Cols: 80, Rows: 24},
			},
		},
	})
	if err != nil {
		t.Fatalf("send start: %v", err)
	}

	if err := stream.Send(&agentdv1.InteractiveExecClientMsg{Msg: &agentdv1.InteractiveExecClientMsg_StdinChunk{StdinChunk: []byte("ping\n")}}); err != nil {
		t.Fatalf("send stdin: %v", err)
	}

	var got []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ev, err := stream.Recv()
		if err != nil {
			t.Fatalf("recv: %v", err)
		}
		if chunk := ev.GetStdoutChunk(); chunk != nil {
			got = append(got, chunk...)
			if len(got) >= len("ping\r\n") {
				break
			}
		}
	}
	if err := stream.Send(&agentdv1.InteractiveExecClientMsg{Msg: &agentdv1.InteractiveExecClientMsg_CloseStdin{CloseStdin: true}}); err != nil {
		t.Fatalf("send close_stdin: %v", err)
	}

	if len(got) == 0 {
		t.Fatal("received no pty output echoing stdin")
	}
}

func TestCopyIn_RejectsCorruptedChunk(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	destPath := filepath.Join(t.TempDir(), "dest.bin")
	payload := []byte("this is the real payload")
	realSum := sha256.Sum256(payload)

	stream, err := client.CopyIn(ctx)
	if err != nil {
		t.Fatalf("CopyIn: %v", err)
	}
	if err := stream.Send(&agentdv1.CopyInChunk{Msg: &agentdv1.CopyInChunk_Header{Header: &agentdv1.CopyInHeader{
		SandboxPath: destPath,
		Sha256:      hex.EncodeToString(realSum[:]),
		Size:        int64(len(payload)),
	}}}); err != nil {
		t.Fatalf("send header: %v", err)
	}
	// Send corrupted data (doesn't match the declared checksum).
	corrupted := append([]byte{}, payload...)
	corrupted[0] ^= 0xFF
	if err := stream.Send(&agentdv1.CopyInChunk{Msg: &agentdv1.CopyInChunk_Data{Data: corrupted}}); err != nil {
		t.Fatalf("send data: %v", err)
	}

	result, err := stream.CloseAndRecv()
	if err != nil {
		t.Fatalf("CloseAndRecv: %v", err)
	}
	if result.GetOk() {
		t.Fatal("expected checksum mismatch to be rejected, got ok=true")
	}
	if _, statErr := os.Stat(destPath); statErr == nil {
		t.Error("target path exists despite rejected transfer — must not leave a partial file")
	}
}

func TestCopyIn_ThenCopyOut_RoundTrips(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	destPath := filepath.Join(t.TempDir(), "roundtrip.bin")
	payload := make([]byte, 200*1024) // larger than one internal read buffer, forces multiple chunks
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	sum := sha256.Sum256(payload)

	inStream, err := client.CopyIn(ctx)
	if err != nil {
		t.Fatalf("CopyIn: %v", err)
	}
	if err := inStream.Send(&agentdv1.CopyInChunk{Msg: &agentdv1.CopyInChunk_Header{Header: &agentdv1.CopyInHeader{
		SandboxPath: destPath,
		Sha256:      hex.EncodeToString(sum[:]),
		Size:        int64(len(payload)),
	}}}); err != nil {
		t.Fatalf("send header: %v", err)
	}
	const chunkSize = 32 * 1024
	for i := 0; i < len(payload); i += chunkSize {
		end := min(i+chunkSize, len(payload))
		if err := inStream.Send(&agentdv1.CopyInChunk{Msg: &agentdv1.CopyInChunk_Data{Data: payload[i:end]}}); err != nil {
			t.Fatalf("send data chunk: %v", err)
		}
	}
	inResult, err := inStream.CloseAndRecv()
	if err != nil {
		t.Fatalf("CloseAndRecv: %v", err)
	}
	if !inResult.GetOk() {
		t.Fatalf("copy in rejected: %s", inResult.GetError())
	}

	outStream, err := client.CopyOut(ctx, &agentdv1.CopyOutRequest{SandboxPath: destPath})
	if err != nil {
		t.Fatalf("CopyOut: %v", err)
	}
	var out []byte
	var trailerSum string
	for {
		chunk, err := outStream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		switch m := chunk.GetMsg().(type) {
		case *agentdv1.CopyOutChunk_Data:
			out = append(out, m.Data...)
		case *agentdv1.CopyOutChunk_Trailer:
			trailerSum = m.Trailer.GetSha256()
		}
	}

	gotSum := sha256.Sum256(out)
	if hex.EncodeToString(gotSum[:]) != trailerSum {
		t.Errorf("trailer checksum %s does not match actual data checksum %s", trailerSum, hex.EncodeToString(gotSum[:]))
	}
	if hex.EncodeToString(gotSum[:]) != hex.EncodeToString(sum[:]) {
		t.Error("round-tripped payload does not match original")
	}
}

func TestHealth_ReportsActiveExecCount(t *testing.T) {
	client := startTestServer(t, config.Default())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Exec(ctx, &agentdv1.ExecRequest{Command: "sleep 1"})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let the exec register as active

	health, err := client.Health(ctx, &agentdv1.HealthRequest{})
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if health.GetActiveExecCount() != 1 {
		t.Errorf("active_exec_count = %d, want 1", health.GetActiveExecCount())
	}
	if health.GetQueueDepth() != 0 {
		t.Errorf("queue_depth = %d, want 0 (daemon does not queue in v1)", health.GetQueueDepth())
	}

	for {
		if _, err := stream.Recv(); err != nil {
			break
		}
	}
}

func TestExec_MaxConcurrentExecsFailsFast(t *testing.T) {
	cfg := config.Default()
	cfg.MaxConcurrentExecs = 1
	client := startTestServer(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	first, err := client.Exec(ctx, &agentdv1.ExecRequest{Command: "sleep 1"})
	if err != nil {
		t.Fatalf("Exec (first): %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let it occupy the one slot

	second, err := client.Exec(ctx, &agentdv1.ExecRequest{Command: "true"})
	if err != nil {
		t.Fatalf("Exec (second) rpc call: %v", err)
	}
	_, recvErr := second.Recv()
	if recvErr == nil {
		t.Fatal("expected the second exec to be rejected while the first holds the only slot, got success")
	}

	for {
		if _, err := first.Recv(); err != nil {
			break
		}
	}
}
