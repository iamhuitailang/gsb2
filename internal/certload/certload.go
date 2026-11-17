// Package certload loads leaf, intermediate and root certificates from PEM
// (or bare DER) files, tolerates malformed input with structured errors and
// deduplicates certificates that appear more than once.
package certload

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"sort"

	"gsb2/certverify/internal/report"
)

// Errors returned to the caller. They are exported so the CLI can map them to
// distinct exit codes without string matching.
var (
	ErrNoCerts      = errors.New("no certificate found in file")
	ErrMalformedPEM = errors.New("malformed PEM input")
	ErrBadCert      = errors.New("certificate parse error")
)

// LoadedCert ties a parsed certificate to where it came from.
type LoadedCert struct {
	Cert        *x509.Certificate
	Source      string
	SourceIndex int // 1-based position of the certificate inside its source file
}

// Result holds every usable certificate found on disk plus diagnostics.
type Result struct {
	Certs      []LoadedCert
	Duplicates int
	Warnings   []string
}

// LoadFiles parses every file in files in order. A file read failure returns
// immediately; per-certificate parse failures are collected and returned as an
// error while still exposing certificates that parsed successfully.
func LoadFiles(files []string) (*Result, error) {
	res := &Result{}

	seen := make(map[string]bool)
	for _, path := range files {
		parsed, err := parseFile(path)
		if err != nil {
			// Read failures and entirely unparseable files abort this file.
			return res, err
		}
		for i, cert := range parsed {
			fp := report.Fingerprint(cert)
			if seen[fp] {
				res.Duplicates++
				res.Warnings = append(res.Warnings,
					fmt.Sprintf("duplicate certificate skipped: subject=%q source=%s#%d",
						cert.Subject.String(), path, i+1))
				continue
			}
			seen[fp] = true
			res.Certs = append(res.Certs, LoadedCert{
				Cert:        cert,
				Source:      path,
				SourceIndex: i + 1,
			})
		}
	}
	sort.Strings(res.Warnings)
	return res, nil
}

// parseFile reads one file and extracts all certificates from it.
func parseFile(path string) ([]*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("%w: %s: file is empty", ErrNoCerts, path)
	}

	if !looksPEM(data) {
		// Bare DER is a legitimate encoding; try it directly.
		cert, derErr := x509.ParseCertificate(data)
		if derErr != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrBadCert, path, derErr)
		}
		return []*x509.Certificate{cert}, nil
	}

	var certs []*x509.Certificate
	rest := data
	certPos := 0
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			if hasNonWhitespace(rest) {
				return nil, fmt.Errorf("%w: %s: trailing data is not valid PEM",
					ErrMalformedPEM, path)
			}
			break
		}
		if block.Type != "CERTIFICATE" {
			// Private keys, metadata blocks, etc. are not certificates. We skip
			// them but record nothing sensitive; a file that contains only such
			// blocks ends up with zero certificates and fails below.
			continue
		}
		certPos++
		cert, parseErr := x509.ParseCertificate(block.Bytes)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: %s: certificate #%d: %v",
				ErrBadCert, path, certPos, parseErr)
		}
		certs = append(certs, cert)
	}
	if len(certs) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNoCerts, path)
	}
	return certs, nil
}

func looksPEM(data []byte) bool {
	for _, line := range splitLines(data) {
		if len(line) >= len("-----BEGIN") &&
			string(line[:len("-----BEGIN")]) == "-----BEGIN" {
			return true
		}
	}
	return false
}

func splitLines(data []byte) [][]byte {
	var lines [][]byte
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, data[start:i])
			start = i + 1
		}
	}
	lines = append(lines, data[start:])
	return lines
}

func hasNonWhitespace(data []byte) bool {
	for _, b := range data {
		if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
			return true
		}
	}
	return false
}
