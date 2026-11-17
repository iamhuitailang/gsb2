// Package chain builds candidate certificate paths from a leaf up to a
// user-supplied trust anchor without consulting the operating system trust
// store. It performs the cryptographic and structural path checks
// (issuer relationship, signature, CA/basic-constraints and path length) so
// that callers can report exactly where and why a path failed.
package chain

import (
	"crypto/x509"
	"fmt"
	"sort"
	"strings"

	"gsb2/certverify/internal/report"
	"gsb2/certverify/internal/sigverify"
)

// Safety bounds on path exploration; real paths are far shorter.
const (
	maxDepth        = 12
	maxValidChains  = 32
	maxFailedRecord = 64
)

// Node is a candidate non-leaf certificate (intermediate or root).
type Node struct {
	Cert        *x509.Certificate
	Source      string
	SourceIndex int
	IsRoot      bool
}

// BuiltChain is one complete leaf-to-root path, certificates in order with
// the leaf at position 0 and the trust anchor last.
type BuiltChain struct {
	Certs []*x509.Certificate
}

// Attempt records a path exploration that ended without a trusted anchor,
// or a completed chain rejected by a structural rule.
type Attempt struct {
	Subjects []string
	Failure  string
}

// Builder holds the pools used to construct paths.
type Builder struct {
	intermediates []Node
	roots         []Node
	// bySubject indexes non-root nodes by raw subject for issuer lookup.
	bySubject map[string][]int
}

// NewBuilder prepares a builder from the intermediate and root pools.
func NewBuilder(intermediates, roots []Node) *Builder {
	b := &Builder{
		intermediates: intermediates,
		roots:         roots,
		bySubject:     make(map[string][]int),
	}
	for i, n := range intermediates {
		key := string(n.Cert.RawSubject)
		b.bySubject[key] = append(b.bySubject[key], i)
	}
	return b
}

// Build explores every viable path from leaf upward. It returns complete
// chains that satisfy the structural path rules, plus failed attempts for the
// report.
func (b *Builder) Build(leaf *x509.Certificate) ([]BuiltChain, []Attempt) {
	var valid []BuiltChain
	var attempts []Attempt
	seenChain := make(map[string]bool)

	var dfs func(current *x509.Certificate, path []*x509.Certificate, visited map[string]bool)
	dfs = func(current *x509.Certificate, path []*x509.Certificate, visited map[string]bool) {
		if len(path) > maxDepth || len(valid) >= maxValidChains {
			attempts = appendAttempt(attempts, path,
				fmt.Sprintf("path exceeds maximum depth of %d certificates", maxDepth))
			return
		}

		// Terminate at a trusted root.
		for i := range b.roots {
			root := b.roots[i]
			if !issuerOf(root.Cert, current) {
				continue
			}
			if err := sigverify.Link(current, root.Cert); err != nil {
				attempts = appendAttempt(attempts, path,
					fmt.Sprintf("candidate root %q signature check failed: %v",
						root.Cert.Subject.String(), err))
				continue
			}
			full := append(append([]*x509.Certificate{}, path...), root.Cert)
			// Path length is enforced as a dedicated check by the verifier,
			// not during construction, so that a completed but violating chain
			// is still reported with the exact constraint that fired.
			key := chainKey(full)
			if seenChain[key] {
				continue
			}
			seenChain[key] = true
			valid = append(valid, BuiltChain{Certs: full})
		}

		// Continue through intermediate CAs.
		for _, idx := range b.bySubject[string(current.RawIssuer)] {
			parent := b.intermediates[idx].Cert
			fp := report.Fingerprint(parent)
			if visited[fp] {
				attempts = appendAttempt(attempts, path,
					fmt.Sprintf("issuer cycle detected at %q", parent.Subject.String()))
				continue
			}
			// The issuer name must actually equal the parent subject.
			if !issuerOf(parent, current) {
				continue
			}
			// Check the CA constraints before cryptography: a non-CA issuer is
			// a clearer structural rejection than a generic signature error.
			if !parent.IsCA || !parent.BasicConstraintsValid {
				attempts = appendAttempt(attempts, append(path, parent),
					fmt.Sprintf("issuer %q is not a CA (missing/invalid basic constraints)",
						parent.Subject.String()))
				continue
			}
			if parent.KeyUsage != 0 && parent.KeyUsage&x509.KeyUsageCertSign == 0 {
				attempts = appendAttempt(attempts, append(path, parent),
					fmt.Sprintf("issuer %q is a CA but keyCertSign is not in its key usage",
						parent.Subject.String()))
				continue
			}
			if err := sigverify.Link(current, parent); err != nil {
				attempts = appendAttempt(attempts, append(path, parent),
					fmt.Sprintf("issuer %q signature check failed: %v",
						parent.Subject.String(), err))
				continue
			}
			visited[fp] = true
			dfs(parent, append(path, parent), visited)
			delete(visited, fp)
		}
	}

	dfs(leaf, []*x509.Certificate{leaf}, map[string]bool{
		report.Fingerprint(leaf): true,
	})

	if len(valid) == 0 && len(attempts) == 0 {
		attempts = appendAttempt(attempts, []*x509.Certificate{leaf},
			"no certificate in the supplied pools names itself as issuer of this certificate")
	}
	sortAttempts(attempts)
	return valid, capAttempts(attempts)
}

// issuerOf reports whether parent names itself as the issuer of child using
// both the distinguished name and (when present) the authority key identifier.
func issuerOf(parent, child *x509.Certificate) bool {
	if string(parent.RawSubject) != string(child.RawIssuer) {
		return false
	}
	if len(child.AuthorityKeyId) > 0 && len(parent.SubjectKeyId) > 0 {
		return string(parent.SubjectKeyId) == string(child.AuthorityKeyId)
	}
	return true
}

// PathLenViolation identifies the certificate whose pathLenConstraint was
// exceeded.
type PathLenViolation struct {
	Cert   *x509.Certificate
	Reason string
}

// CheckPathLength enforces RFC 5280 §4.2.1.9: for every non-self-issued CA
// certificate in the chain that asserts a pathLenConstraint, the number of
// non-self-issued intermediate certificates below it must not exceed it.
func CheckPathLength(chain []*x509.Certificate) (PathLenViolation, bool) {
	// Positions 0..len-2 may carry constraints; the anchor is last.
	for pos := 0; pos < len(chain)-1; pos++ {
		ca := chain[pos]
		// MaxPathLen==0 with MaxPathLenZero==false means no constraint set.
		if !ca.IsCA || (ca.MaxPathLen == 0 && !ca.MaxPathLenZero) {
			continue
		}
		// Count non-self-issued intermediates strictly below this CA and above
		// the leaf (i.e. positions pos+1 .. len-2).
		below := 0
		for j := pos + 1; j < len(chain)-1; j++ {
			c := chain[j]
			if !isSelfIssued(c) {
				below++
			}
		}
		limit := ca.MaxPathLen
		if ca.MaxPathLenZero {
			limit = 0
		}
		if below > limit {
			return PathLenViolation{
				Cert: ca,
				Reason: fmt.Sprintf("pathLenConstraint=%d but %d non-self-issued intermediate CA(s) sit below it",
					limit, below),
			}, false
		}
	}
	return PathLenViolation{}, true
}

func isSelfIssued(c *x509.Certificate) bool {
	return string(c.RawSubject) == string(c.RawIssuer)
}

func chainKey(chain []*x509.Certificate) string {
	parts := make([]string, len(chain))
	for i, c := range chain {
		parts[i] = report.Fingerprint(c)
	}
	return strings.Join(parts, "|")
}

func appendAttempt(attempts []Attempt, path []*x509.Certificate, failure string) []Attempt {
	if len(attempts) >= maxFailedRecord {
		return attempts
	}
	subjects := make([]string, 0, len(path))
	for _, c := range path {
		subjects = append(subjects, c.Subject.String())
	}
	return append(attempts, Attempt{Subjects: subjects, Failure: failure})
}

func capAttempts(attempts []Attempt) []Attempt {
	if len(attempts) > maxFailedRecord {
		return attempts[:maxFailedRecord]
	}
	return attempts
}

func sortAttempts(attempts []Attempt) {
	sort.SliceStable(attempts, func(i, j int) bool {
		return strings.Join(attempts[i].Subjects, "|")+attempts[i].Failure <
			strings.Join(attempts[j].Subjects, "|")+attempts[j].Failure
	})
}
