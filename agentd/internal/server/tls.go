package server

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// LoadServerTLSConfig builds a tls.Config that requires and verifies a
// client certificate signed by the CA at clientCAFile — any client
// presenting such a certificate is trusted (a single-tenant operational
// model; see docs/adr/0024-daemon-transport-for-fyre.md for why this doesn't
// do per-client authorization).
func LoadServerTLSConfig(serverCertFile, serverKeyFile, clientCAFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(serverCertFile, serverKeyFile)
	if err != nil {
		return nil, fmt.Errorf("agentd: load server cert/key: %w", err)
	}

	caPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return nil, fmt.Errorf("agentd: read client CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("agentd: no valid certificates found in %s", clientCAFile)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		MinVersion:   tls.VersionTLS13,
	}, nil
}
