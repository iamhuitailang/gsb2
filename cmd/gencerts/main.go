// Command gencerts produces a small, fully offline set of demonstration
// certificates under demo/certs. All material is generated locally with
// deterministic test keys; no private key material is printed by the main
// tool, and nothing here contacts the network or the system trust store.
//
// The generated set covers: a valid chain, an untrusted root, a wrong-hostname
// leaf, an expired leaf, an EKU mismatch, a non-CA issuer, a weak-key root and
// a SHA-1 root, so the README walkthroughs exercise every exit code.
package main

import (
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gsb2/certverify/internal/testca"
)

// demoTime is the fixed reference instant the README walkthroughs verify at.
var demoTime = time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

func main() {
	dir := "demo/certs"
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal(err)
	}

	validRoot := testca.Root("Demo Trust Root")
	inter := validRoot.Intermediate("Demo Intermediate CA", 1, false)
	goodLeaf, _ := inter.Leaf("demo.example", []string{"demo.example", "www.demo.example"})

	write(filepath.Join(dir, "root.pem"), testca.PEMEncode(validRoot.Cert))
	write(filepath.Join(dir, "intermediate.pem"), testca.PEMEncode(inter.Cert))
	write(filepath.Join(dir, "leaf-good.pem"), testca.PEMEncode(goodLeaf))

	// An unrelated root: a chain that cryptographically validates but is untrusted.
	otherRoot := testca.Root("Demo Other Root")
	write(filepath.Join(dir, "root-untrusted.pem"), testca.PEMEncode(otherRoot.Cert))

	// A leaf whose SAN does not contain the requested hostname.
	wrongName, _ := inter.Leaf("other.example", []string{"other.example"})
	write(filepath.Join(dir, "leaf-wrong-name.pem"), testca.PEMEncode(wrongName))

	// A leaf that has already expired at the fixed verification time.
	expired, _ := inter.Leaf(
		"expired.demo.example", []string{"expired.demo.example"},
		testca.WithLeafValidity(demoTime.AddDate(-2, 0, 0), demoTime.AddDate(-1, 0, 0)),
	)
	write(filepath.Join(dir, "leaf-expired.pem"), testca.PEMEncode(expired))

	// A leaf usable only for client authentication.
	clientOnly, _ := inter.Leaf("client.demo.example", []string{"client.demo.example"},
		testca.WithEKU(x509.ExtKeyUsageClientAuth))
	write(filepath.Join(dir, "leaf-client-only.pem"), testca.PEMEncode(clientOnly))

	// A certificate issued by a non-CA entity.
	nonCA, nonCAKey := inter.Leaf("not-a-ca.demo.example", []string{"not-a-ca.demo.example"})
	rogue := inter.LeafSignedBy(
		&testca.CA{Cert: nonCA, Key: nonCAKey}, "rogue.demo.example", []string{"rogue.demo.example"})
	write(filepath.Join(dir, "leaf-nonca-issuer.pem"), testca.PEMEncode(rogue))
	write(filepath.Join(dir, "nonca-issuer.pem"), testca.PEMEncode(nonCA))

	// A chain rooted at a weak (RSA-1024) certificate.
	weakRoot := testca.Root("Demo Weak Root", testca.WithWeakRSA())
	weakLeaf, _ := weakRoot.Leaf("weak.demo.example", []string{"weak.demo.example"})
	write(filepath.Join(dir, "root-weak-1024.pem"), testca.PEMEncode(weakRoot.Cert))
	write(filepath.Join(dir, "leaf-weak-root.pem"), testca.PEMEncode(weakLeaf))

	// A chain rooted at a SHA-1 signature (cryptographically verifiable but
	// below the default policy boundary).
	sha1Root := testca.Root("Demo SHA1 Root", testca.WithSHA1())
	sha1Leaf, _ := sha1Root.Leaf("sha1.demo.example", []string{"sha1.demo.example"})
	write(filepath.Join(dir, "root-sha1.pem"), testca.PEMEncode(sha1Root.Cert))
	write(filepath.Join(dir, "leaf-sha1.pem"), testca.PEMEncode(sha1Leaf))

	fmt.Printf("demo certificates written to %s\n", dir)
	fmt.Println("regenerate any time with: go run ./cmd/gencerts")
}

func write(path string, data []byte) {
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "gencerts:", err)
	os.Exit(1)
}
