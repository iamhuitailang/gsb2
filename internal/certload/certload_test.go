package certload_test

import (
	"os"
	"path/filepath"
	"testing"

	"gsb2/certverify/internal/certload"
	"gsb2/certverify/internal/testca"
)

func writeFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func TestLoadsMultiplePEMCertsAndDeduplicates(t *testing.T) {
	root := testca.Root("Load Root")
	leaf, _ := root.Leaf("load.example", []string{"load.example"})
	dir := t.TempDir()

	// Same leaf appears twice, including in a second file.
	path := writeFile(t, dir, "bundle.pem",
		append(testca.PEMEncode(leaf), testca.PEMEncode(leaf)...))
	path2 := writeFile(t, dir, "again.pem", testca.PEMEncode(leaf))

	res, err := certload.LoadFiles([]string{path, path2})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Certs) != 1 {
		t.Fatalf("expected 1 unique certificate, got %d", len(res.Certs))
	}
	if res.Duplicates != 2 {
		t.Fatalf("expected 2 duplicates, got %d", res.Duplicates)
	}
}

func TestLoadsBareDER(t *testing.T) {
	root := testca.Root("DER Root")
	dir := t.TempDir()
	path := writeFile(t, dir, "root.der", root.Cert.Raw)

	res, err := certload.LoadFiles([]string{path})
	if err != nil {
		t.Fatalf("bare DER should load: %v", err)
	}
	if len(res.Certs) != 1 {
		t.Fatalf("expected 1 certificate, got %d", len(res.Certs))
	}
}

func TestMissingFile(t *testing.T) {
	_, err := certload.LoadFiles([]string{filepath.Join(t.TempDir(), "absent.pem")})
	if err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestEmptyFileIsNoCerts(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, "empty.pem", nil)
	_, err := certload.LoadFiles([]string{path})
	if !errorIs(err, certload.ErrNoCerts) {
		t.Fatalf("expected ErrNoCerts, got %v", err)
	}
}

func TestCorruptPEM(t *testing.T) {
	root := testca.Root("Corrupt Root")
	dir := t.TempDir()
	path := writeFile(t, dir, "corrupt.pem", testca.CorruptPEM(root.Cert))
	_, err := certload.LoadFiles([]string{path})
	if !errorIs(err, certload.ErrBadCert) {
		t.Fatalf("expected ErrBadCert, got %v", err)
	}
}

func TestMalformedPEMTrailingData(t *testing.T) {
	root := testca.Root("Trailing Root")
	dir := t.TempDir()
	data := append(testca.PEMEncode(root.Cert), []byte("this is not pem at all")...)
	path := writeFile(t, dir, "trailing.pem", data)
	_, err := certload.LoadFiles([]string{path})
	if !errorIs(err, certload.ErrMalformedPEM) {
		t.Fatalf("expected ErrMalformedPEM, got %v", err)
	}
}

func TestNonCertificatePEMBlock(t *testing.T) {
	dir := t.TempDir()
	// A well-formed non-certificate PEM block with no certificates in the file.
	data := []byte("-----BEGIN PRIVATE KEY-----\nBM8CAQAwHQYLKoZIhvcNAQkQAQqwewYJKoZIhvcNAQcBMQsw\n-----END PRIVATE KEY-----\n")
	path := writeFile(t, dir, "keyonly.pem", data)
	_, err := certload.LoadFiles([]string{path})
	if !errorIs(err, certload.ErrNoCerts) {
		t.Fatalf("expected ErrNoCerts, got %v", err)
	}
}

func errorIs(err, target error) bool {
	return err != nil && (err == target || containsErr(err, target))
}

func containsErr(err, target error) bool {
	for err != nil {
		if err == target {
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
