.PHONY: build test vet cover demo clean

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

cover:
	go test ./... -cover

# Regenerate the offline, non-sensitive demonstration certificates.
demo:
	go run ./cmd/gencerts

clean:
	rm -f demo/certs/*.pem
