//go:build linux

package health

import (
	"os"
	"strconv"
	"strings"
)

// loadAvg1 reads the 1-minute load average from /proc/loadavg, the standard
// source on the Linux hosts this daemon actually deploys to (the Fyre VMs).
func loadAvg1() float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return v
}
