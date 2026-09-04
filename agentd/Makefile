PROTO_DIR := ../proto/agentd/v1
GEN_DIR := gen/agentd/v1

.PHONY: proto build test

proto:
	protoc \
		--go_out=$(GEN_DIR) --go_opt=paths=source_relative \
		--go-grpc_out=$(GEN_DIR) --go-grpc_opt=paths=source_relative \
		-I $(PROTO_DIR) \
		$(PROTO_DIR)/agentd.proto

build:
	go build ./...

test:
	go test ./...
