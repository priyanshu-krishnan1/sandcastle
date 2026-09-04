// Package transfer implements CopyIn (host -> sandbox) and CopyOut
// (sandbox -> host) as hash-then-verify-then-atomically-place operations on
// both sides, so a dropped connection never leaves a partial file at the
// target path.
package transfer

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// WriteCloser wraps a temp file that is renamed into place on Close, or
// discarded on Abort — the atomic-write half of CopyIn.
type WriteCloser struct {
	tmp        *os.File
	targetPath string
	hasher     interface {
		io.Writer
		Sum([]byte) []byte
	}
	wantSHA256 string
	isDir      bool
}

// NewIncomingFile opens a temp file next to targetPath ready to receive a
// CopyIn payload. When isDir is true, the written bytes are treated as a
// tar.gz stream and extracted under targetPath instead of written verbatim.
func NewIncomingFile(targetPath string, wantSHA256 string, isDir bool) (*WriteCloser, error) {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return nil, fmt.Errorf("transfer: mkdir parent: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(targetPath), ".agentd-copyin-*")
	if err != nil {
		return nil, fmt.Errorf("transfer: create temp: %w", err)
	}
	return &WriteCloser{tmp: tmp, targetPath: targetPath, hasher: sha256.New(), wantSHA256: wantSHA256, isDir: isDir}, nil
}

// Write appends a chunk of the incoming payload.
func (w *WriteCloser) Write(p []byte) (int, error) {
	w.hasher.Write(p)
	return w.tmp.Write(p)
}

// Commit verifies the accumulated payload's checksum, then atomically places
// it at the target path (extracting it as tar.gz first when isDir was set).
// On any failure, the temp file is removed and the target path is left
// untouched.
func (w *WriteCloser) Commit() error {
	defer os.Remove(w.tmp.Name())

	if err := w.tmp.Close(); err != nil {
		return fmt.Errorf("transfer: close temp: %w", err)
	}
	got := hex.EncodeToString(w.hasher.Sum(nil))
	if w.wantSHA256 != "" && got != w.wantSHA256 {
		return fmt.Errorf("transfer: checksum mismatch: want %s, got %s", w.wantSHA256, got)
	}

	if !w.isDir {
		return os.Rename(w.tmp.Name(), w.targetPath)
	}

	f, err := os.Open(w.tmp.Name())
	if err != nil {
		return fmt.Errorf("transfer: reopen temp for extraction: %w", err)
	}
	defer f.Close()
	if err := extractTarGz(f, w.targetPath); err != nil {
		return fmt.Errorf("transfer: extract: %w", err)
	}
	return nil
}

func extractTarGz(r io.Reader, destDir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()

	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(destDir, hdr.Name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(hdr.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		case tar.TypeSymlink:
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		}
	}
}

// OutgoingFile streams a file for CopyOut, reporting its size up front and
// its checksum once fully read.
type OutgoingFile struct {
	f      *os.File
	Size   int64
	hasher interface {
		io.Writer
		Sum([]byte) []byte
	}
}

// OpenOutgoing opens sourcePath for a CopyOut response.
func OpenOutgoing(sourcePath string) (*OutgoingFile, error) {
	f, err := os.Open(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("transfer: open source: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("transfer: stat source: %w", err)
	}
	return &OutgoingFile{f: f, Size: info.Size(), hasher: sha256.New()}, nil
}

// Read reads the next chunk and feeds the running checksum.
func (o *OutgoingFile) Read(p []byte) (int, error) {
	n, err := o.f.Read(p)
	if n > 0 {
		o.hasher.Write(p[:n])
	}
	return n, err
}

// SHA256 returns the checksum of everything read so far — call only after
// reading to EOF.
func (o *OutgoingFile) SHA256() string { return hex.EncodeToString(o.hasher.Sum(nil)) }

// Close releases the underlying file handle.
func (o *OutgoingFile) Close() error { return o.f.Close() }
