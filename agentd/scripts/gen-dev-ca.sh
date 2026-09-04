#!/usr/bin/env bash
# Generates a throwaway CA + one server cert + one client cert for local
# development and manual smoke testing (e.g. with grpcurl). NOT for
# production fleet use — see README.md's "Fleet mTLS bootstrap" section for
# the real per-host provisioning process this stands in for.
#
# Usage: scripts/gen-dev-ca.sh [output-dir]   (default: ./dev-certs)
set -euo pipefail

OUT_DIR="${1:-dev-certs}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

echo "Generating dev CA + server + client certs in $(pwd)"

# CA
openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -x509 -new -key ca-key.pem -days 30 -out ca-cert.pem \
  -subj "/CN=agentd-dev-ca"

# Server cert (CN=localhost, SAN covers localhost + 127.0.0.1 for local testing)
openssl ecparam -name prime256v1 -genkey -noout -out server-key.pem
openssl req -new -key server-key.pem -out server.csr -subj "/CN=localhost"
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -days 30 -out server-cert.pem \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth")

# Client cert (used by the fyreDaemon TS provider / grpcurl)
openssl ecparam -name prime256v1 -genkey -noout -out client-key.pem
openssl req -new -key client-key.pem -out client.csr -subj "/CN=agentd-dev-client"
openssl x509 -req -in client.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -days 30 -out client-cert.pem \
  -extfile <(printf "extendedKeyUsage=clientAuth")

rm -f server.csr client.csr ca-cert.srl

echo "Done. Start the daemon with:"
echo "  go run ./cmd/agentd -listen :8443 -server-cert $OUT_DIR/server-cert.pem -server-key $OUT_DIR/server-key.pem -client-ca $OUT_DIR/ca-cert.pem"
