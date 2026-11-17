// Package hostname implements RFC 6125 style server-name verification.
//
// The important rule: when a certificate carries a Subject Alternative Name
// extension, the Common Name is never consulted. CN matching is only used for
// certificates without any SAN, and only when the caller explicitly opts in
// via AllowLegacyCN. IP addresses are matched exclusively against iPAddress
// SANs and never against a DNS name or CN.
package hostname

import (
	"crypto/x509"
	"net"
	"strings"
)

// Result explains how the name decision was reached.
type Result struct {
	Matched bool
	// Detail is a short human-readable explanation of the decision.
	Detail string
	// Evidence lists the names actually consulted from the SAN extension.
	Evidence []string
	// CNUsed reports whether the Common Name was used for the decision.
	CNUsed bool
}

// Verify checks whether name is covered by the certificate's naming rules.
func Verify(cert *x509.Certificate, name string, allowLegacyCN bool) Result {
	if name == "" {
		return Result{Matched: true, Detail: "no target hostname supplied; hostname check skipped"}
	}

	if ip := net.ParseIP(name); ip != nil {
		return verifyIP(cert, ip)
	}
	return verifyDNS(cert, name, allowLegacyCN)
}

func verifyIP(cert *x509.Certificate, ip net.IP) Result {
	for _, candidate := range cert.IPAddresses {
		if candidate.Equal(ip) {
			return Result{
				Matched:  true,
				Detail:   "target IP matches an iPAddress SAN",
				Evidence: StringIP(cert.IPAddresses),
			}
		}
	}
	return Result{
		Matched:  false,
		Detail:   "target IP is not present in the iPAddress SAN list; Common Name is never used for IP names",
		Evidence: StringIP(cert.IPAddresses),
	}
}

func verifyDNS(cert *x509.Certificate, name string, allowLegacyCN bool) Result {
	// Build the SAN view once. The presence of a SAN extension, even one with
	// zero DNS names, means the CN must not be consulted (RFC 6125 §6.4.4).
	hasSAN := len(cert.DNSNames) > 0 || len(cert.IPAddresses) > 0 ||
		len(cert.EmailAddresses) > 0 || len(cert.URIs) > 0

	evidence := append([]string(nil), cert.DNSNames...)

	if hasSAN {
		lower := strings.ToLower(strings.TrimSuffix(name, "."))
		for _, dns := range cert.DNSNames {
			if matchWildcard(strings.ToLower(dns), lower) {
				return Result{
					Matched:  true,
					Detail:   "target hostname matches a dNSName SAN",
					Evidence: evidence,
				}
			}
		}
		return Result{
			Matched:  false,
			Detail:   "target hostname does not match any dNSName SAN; Common Name is ignored because a SAN extension is present",
			Evidence: evidence,
		}
	}

	// No SAN extension: CN is consulted only under explicit legacy opt-in.
	if allowLegacyCN {
		cn := cert.Subject.CommonName
		if cn != "" && matchWildcard(strings.ToLower(cn), strings.ToLower(strings.TrimSuffix(name, "."))) {
			return Result{
				Matched:  true,
				CNUsed:   true,
				Detail:   "certificate has no SAN; target hostname matches the legacy Common Name (explicitly allowed)",
				Evidence: evidence,
			}
		}
		return Result{
			Matched:  false,
			CNUsed:   true,
			Detail:   "certificate has no SAN and its Common Name does not match the target hostname",
			Evidence: evidence,
		}
	}

	return Result{
		Matched:  false,
		Detail:   "certificate has no Subject Alternative Name and legacy Common Name matching is disabled",
		Evidence: evidence,
	}
}

// matchWildcard implements the single-label leftmost wildcard rule from
// RFC 6125: only the leftmost label may be "*", and it matches exactly one
// label (never dots, never the empty string).
func matchWildcard(pattern, host string) bool {
	if !strings.Contains(pattern, "*") {
		return pattern == host
	}
	if strings.Count(pattern, "*") != 1 || !strings.HasPrefix(pattern, "*.") {
		return false
	}
	patternLabels := strings.Split(pattern, ".")
	hostLabels := strings.Split(host, ".")
	if len(patternLabels) != len(hostLabels) {
		return false
	}
	// First label: wildcard matches any single, non-empty host label.
	if hostLabels[0] == "" {
		return false
	}
	for i := 1; i < len(patternLabels); i++ {
		if patternLabels[i] != hostLabels[i] {
			return false
		}
	}
	return true
}

// StringIP renders IP SANs as stable strings for report evidence.
func StringIP(ips []net.IP) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		out = append(out, ip.String())
	}
	return out
}
