// Package server implements the AgentDaemon gRPC service, wiring the
// exec/interactive/transfer/health packages into the wire contract defined
// in proto/agentd/v1/agentd.proto.
package server

import (
	"context"
	"errors"
	"io"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	agentdv1 "github.com/ai-hero/sandcastle/agentd/gen/agentd/v1"
	"github.com/ai-hero/sandcastle/agentd/internal/config"
	execpkg "github.com/ai-hero/sandcastle/agentd/internal/exec"
	"github.com/ai-hero/sandcastle/agentd/internal/health"
	"github.com/ai-hero/sandcastle/agentd/internal/interactive"
	"github.com/ai-hero/sandcastle/agentd/internal/transfer"
)

// Server implements agentdv1.AgentDaemonServer.
type Server struct {
	agentdv1.UnimplementedAgentDaemonServer

	cfg     config.Config
	tracker *health.Tracker
	sem     chan struct{} // coarse MaxConcurrentExecs safety net, not a scheduler
}

// New constructs a Server ready to be registered with a grpc.Server.
func New(cfg config.Config) *Server {
	return &Server{
		cfg:     cfg,
		tracker: health.NewTracker(),
		sem:     make(chan struct{}, cfg.MaxConcurrentExecs),
	}
}

func (s *Server) acquireSlot() bool {
	select {
	case s.sem <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releaseSlot() { <-s.sem }

// Exec streams one ExecEvent per output line, then a terminal ExitResult.
func (s *Server) Exec(req *agentdv1.ExecRequest, stream grpc.ServerStreamingServer[agentdv1.ExecEvent]) error {
	if !s.acquireSlot() {
		return status.Error(codes.ResourceExhausted, "agentd: max concurrent execs reached")
	}
	defer s.releaseSlot()

	s.tracker.BeginExec()
	defer s.tracker.EndExec()

	cwd := req.GetCwd()
	if cwd == "" {
		cwd = s.cfg.DefaultCwd
	}

	execReq := execpkg.Request{
		Command: req.GetCommand(),
		Cwd:     cwd,
		Sudo:    req.GetSudo(),
		Env:     req.GetEnv(),
		Stdin:   req.Stdin,
	}

	var sendErr error
	result, runErr := execpkg.Run(stream.Context(), execReq, func(ev execpkg.LineEvent) {
		if sendErr != nil {
			return // stream already broken; stop trying, exec.Run still drains to completion
		}
		line := &agentdv1.LineOutput{Line: ev.Line, Seq: ev.Seq}
		var event *agentdv1.ExecEvent
		if ev.Stream == "stdout" {
			event = &agentdv1.ExecEvent{Event: &agentdv1.ExecEvent_StdoutLine{StdoutLine: line}}
		} else {
			event = &agentdv1.ExecEvent{Event: &agentdv1.ExecEvent_StderrLine{StderrLine: line}}
		}
		sendErr = stream.Send(event)
	})
	if sendErr != nil {
		return sendErr
	}
	if runErr != nil {
		if errors.Is(runErr, context.Canceled) {
			return status.Error(codes.Canceled, "agentd: exec cancelled")
		}
		return status.Errorf(codes.Internal, "agentd: exec failed: %v", runErr)
	}

	return stream.Send(&agentdv1.ExecEvent{Event: &agentdv1.ExecEvent_Exit{Exit: &agentdv1.ExitResult{ExitCode: result.ExitCode}}})
}

// InteractiveExec runs a pty (or plain-pipe) session, pumping stdin/resize
// in and stdout/stderr/exit out.
func (s *Server) InteractiveExec(stream grpc.BidiStreamingServer[agentdv1.InteractiveExecClientMsg, agentdv1.InteractiveExecServerMsg]) error {
	if !s.acquireSlot() {
		return status.Error(codes.ResourceExhausted, "agentd: max concurrent execs reached")
	}
	defer s.releaseSlot()

	first, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "agentd: expected start message: %v", err)
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "agentd: first message must be InteractiveExecStart")
	}

	cwd := start.GetCwd()
	if cwd == "" {
		cwd = s.cfg.DefaultCwd
	}
	var cols, rows uint16
	if sz := start.GetInitialSize(); sz != nil {
		cols, rows = uint16(sz.GetCols()), uint16(sz.GetRows())
	}

	sess, err := interactive.Start(interactive.StartOptions{
		Args: start.GetArgs(),
		Cwd:  cwd,
		Env:  start.GetEnv(),
		Sudo: start.GetSudo(),
		Pty:  start.GetPty(),
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		return status.Errorf(codes.Internal, "agentd: interactive exec failed to start: %v", err)
	}
	defer sess.Close()

	s.tracker.BeginInteractive()
	defer s.tracker.EndInteractive()

	var sendErr error
	sendMu := make(chan struct{}, 1)
	sendMu <- struct{}{}
	send := func(msg *agentdv1.InteractiveExecServerMsg) {
		<-sendMu
		defer func() { sendMu <- struct{}{} }()
		if sendErr != nil {
			return
		}
		sendErr = stream.Send(msg)
	}

	go func() {
		sess.Pump(
			func(chunk []byte) {
				send(&agentdv1.InteractiveExecServerMsg{Msg: &agentdv1.InteractiveExecServerMsg_StdoutChunk{StdoutChunk: chunk}})
			},
			func(chunk []byte) {
				send(&agentdv1.InteractiveExecServerMsg{Msg: &agentdv1.InteractiveExecServerMsg_StderrChunk{StderrChunk: chunk}})
			},
		)
	}()

	go func() {
		for {
			msg, err := stream.Recv()
			if err != nil {
				return
			}
			switch m := msg.GetMsg().(type) {
			case *agentdv1.InteractiveExecClientMsg_StdinChunk:
				_, _ = sess.Write(m.StdinChunk)
			case *agentdv1.InteractiveExecClientMsg_Resize:
				_ = sess.Resize(uint16(m.Resize.GetCols()), uint16(m.Resize.GetRows()))
			case *agentdv1.InteractiveExecClientMsg_CloseStdin:
				_ = sess.CloseStdin()
			}
		}
	}()

	exitCode := sess.Wait()
	send(&agentdv1.InteractiveExecServerMsg{Msg: &agentdv1.InteractiveExecServerMsg_Exit{Exit: &agentdv1.ExitResult{ExitCode: exitCode}}})
	return sendErr
}

// CopyIn receives a header then chunked bytes, verifying the checksum and
// atomically placing the result before responding.
func (s *Server) CopyIn(stream grpc.ClientStreamingServer[agentdv1.CopyInChunk, agentdv1.CopyInResult]) error {
	first, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "agentd: expected header: %v", err)
	}
	header := first.GetHeader()
	if header == nil {
		return status.Error(codes.InvalidArgument, "agentd: first message must be CopyInHeader")
	}

	dest, err := transfer.NewIncomingFile(header.GetSandboxPath(), header.GetSha256(), header.GetIsDirectory())
	if err != nil {
		return status.Errorf(codes.Internal, "agentd: copy in failed: %v", err)
	}

	for {
		chunk, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "agentd: copy in failed: %v", err)
		}
		if _, err := dest.Write(chunk.GetData()); err != nil {
			return status.Errorf(codes.Internal, "agentd: copy in failed: %v", err)
		}
	}

	if err := dest.Commit(); err != nil {
		return stream.SendAndClose(&agentdv1.CopyInResult{Ok: false, Error: err.Error()})
	}
	return stream.SendAndClose(&agentdv1.CopyInResult{Ok: true})
}

// CopyOut streams a header, then chunked bytes, then a trailer carrying the
// checksum for the client to verify.
func (s *Server) CopyOut(req *agentdv1.CopyOutRequest, stream grpc.ServerStreamingServer[agentdv1.CopyOutChunk]) error {
	src, err := transfer.OpenOutgoing(req.GetSandboxPath())
	if err != nil {
		return status.Errorf(codes.NotFound, "agentd: copy out failed: %v", err)
	}
	defer src.Close()

	if err := stream.Send(&agentdv1.CopyOutChunk{Msg: &agentdv1.CopyOutChunk_Header{Header: &agentdv1.CopyOutHeader{Size: src.Size}}}); err != nil {
		return err
	}

	buf := make([]byte, 64*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if sendErr := stream.Send(&agentdv1.CopyOutChunk{Msg: &agentdv1.CopyOutChunk_Data{Data: data}}); sendErr != nil {
				return sendErr
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "agentd: copy out failed: %v", err)
		}
	}

	return stream.Send(&agentdv1.CopyOutChunk{Msg: &agentdv1.CopyOutChunk_Trailer{Trailer: &agentdv1.CopyOutTrailer{Sha256: src.SHA256()}}})
}

// Health reports the daemon's current load/activity snapshot.
func (s *Server) Health(context.Context, *agentdv1.HealthRequest) (*agentdv1.HealthResponse, error) {
	snap := s.tracker.Snapshot()
	return &agentdv1.HealthResponse{
		ActiveExecCount:        snap.ActiveExecCount,
		ActiveInteractiveCount: snap.ActiveInteractiveCount,
		QueueDepth:             snap.QueueDepth,
		Load1:                  snap.Load1,
		UptimeSeconds:          snap.UptimeSeconds,
		DaemonVersion:          snap.DaemonVersion,
	}, nil
}
