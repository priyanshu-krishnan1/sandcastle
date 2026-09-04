//go:build !linux

package health

// loadAvg1 has no portable implementation outside Linux; this daemon deploys
// to Linux Fyre VMs, so non-Linux builds (used for local dev/testing on
// macOS) simply report 0 rather than shelling out to `uptime`.
func loadAvg1() float64 {
	return 0
}
