//go:build unix

package exec

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts cmd in its own process group so killProcessGroup can
// signal the whole tree (the command may itself spawn further children) via
// a negative PID, instead of only the direct child.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
