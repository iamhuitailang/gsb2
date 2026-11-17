// Package report defines the stable, JSON-serializable verification result
// types shared by the verification engine, the CLI and the tests.
package report

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"time"
)

// Status is the final decision for a single leaf certificate.
type Status string

const (
	StatusTrusted  Status = "TRUSTED"
	StatusRejected Status = "REJECTED"
)

// CheckStatus is the outcome of a single verification check.
type CheckStatus string

const (
	CheckPass CheckStatus = "PASS"
	CheckFail CheckStatus = "FAIL"
	CheckInfo CheckStatus = "INFO"
)

// CertRef is a stable, non-sensitive reference to a certificate.
// It never contains private key material.
type CertRef struct {
	Subject     string `json:"subject"`
	Issuer      string `json:"issuer"`
	Serial      string `json:"serial"`
	SHA256      string `json:"sha256"`
	NotBefore   string `json:"not_before"`
	NotAfter    string `json:"not_after"`
	IsCA        bool   `json:"is_ca"`
	Source      string `json:"source"`
	SourceIndex int    `json:"source_index"`
}

// Check is one item in the per-leaf verification checklist.
type Check struct {
	ID       string      `json:"id"`
	Title    string      `json:"title"`
	Status   CheckStatus `json:"status"`
	Detail   string      `json:"detail"`
	Cert     *CertRef    `json:"cert,omitempty"`
	Evidence []string    `json:"evidence,omitempty"`
}

// ChainCert is one certificate inside a selected verification chain.
type ChainCert struct {
	Position int     `json:"position"`
	Role     string  `json:"role"`
	Cert     CertRef `json:"cert"`
}

// ChainAttempt records a chain-building path that could not be completed,
// together with the reason it failed.
type ChainAttempt struct {
	Subjects []string `json:"subjects"`
	Failure  string   `json:"failure,omitempty"`
}

// LeafResult is the full verification result for one leaf certificate.
type LeafResult struct {
	Leaf          CertRef        `json:"leaf"`
	Decision      Status         `json:"decision"`
	Summary       string         `json:"summary"`
	SelectedChain []ChainCert    `json:"selected_chain"`
	Checks        []Check        `json:"checks"`
	ChainAttempts []ChainAttempt `json:"chain_attempts,omitempty"`
}

// InputStats summarizes how the input files were parsed and deduplicated.
type InputStats struct {
	LeafFiles         []string `json:"leaf_files"`
	IntermediateFiles []string `json:"intermediate_files"`
	RootFiles         []string `json:"root_files"`
	LoadedCerts       int      `json:"loaded_certs"`
	DuplicateCerts    int      `json:"duplicate_certs"`
	Warnings          []string `json:"warnings,omitempty"`
}

// PolicyView is the effective security policy embedded in the report.
type PolicyView struct {
	MinRSABits       int      `json:"min_rsa_bits"`
	MinECDSABits     int      `json:"min_ecdsa_bits"`
	RejectSHA1       bool     `json:"reject_sha1"`
	RejectedSigAlgs  []string `json:"rejected_signature_algorithms"`
	RejectedKeyTypes []string `json:"rejected_key_types"`
}

// Document is the top-level report emitted by the CLI.
type Document struct {
	Tool            string       `json:"tool"`
	Version         string       `json:"version"`
	VerificationUTC string       `json:"verification_time_utc"`
	Hostname        string       `json:"hostname,omitempty"`
	Purposes        []string     `json:"purposes"`
	AllowLegacyCN   bool         `json:"allow_legacy_cn"`
	Policy          PolicyView   `json:"policy"`
	Inputs          InputStats   `json:"inputs"`
	Results         []LeafResult `json:"results"`
	FinalDecision   Status       `json:"final_decision"`
}

// Fingerprint returns the lowercase hex SHA-256 of the raw DER certificate.
func Fingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

// NewCertRef builds a CertRef for a parsed certificate.
func NewCertRef(c *x509.Certificate, source string, sourceIndex int) CertRef {
	serial := "0x" + hex.EncodeToString(c.SerialNumber.Bytes())
	return CertRef{
		Subject:     c.Subject.String(),
		Issuer:      c.Issuer.String(),
		Serial:      serial,
		SHA256:      Fingerprint(c),
		NotBefore:   c.NotBefore.UTC().Format(time.RFC3339),
		NotAfter:    c.NotAfter.UTC().Format(time.RFC3339),
		IsCA:        c.IsCA,
		Source:      source,
		SourceIndex: sourceIndex,
	}
}

// JSON renders the document as indented JSON with a trailing newline.
// Field order is fixed by the struct tags, so output is stable across runs.
func JSON(d *Document) ([]byte, error) {
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
