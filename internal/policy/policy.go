// Package policy defines explicit, conservative security boundaries for
// signature algorithms and public-key strength, and evaluates certificates
// against them. Boundaries are deliberately fixed and stated in the report so
// that a rejection always names the certificate and the rule that fired.
package policy

import (
	"crypto/dsa"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"fmt"
)

// Policy is the effective security boundary.
type Policy struct {
	MinRSABits   int
	MinECDSABits int
	// RejectSHA1 rejects every SHA-1-based signature algorithm. MD2/MD5 are
	// always rejected regardless of this flag.
	RejectSHA1 bool
}

// Default is the boundary applied unless the CLI overrides individual knobs.
func Default() Policy {
	return Policy{
		MinRSABits:   2048,
		MinECDSABits: 256, // P-256
		RejectSHA1:   true,
	}
}

// Violation names the certificate that broke a boundary and explains why.
type Violation struct {
	Cert   *x509.Certificate
	Reason string
}

// RejectedSigAlgs lists the signature algorithm families that are never
// accepted, for inclusion in the report.
func RejectedSigAlgs(p Policy) []string {
	algs := []string{"MD2-RSA", "MD5-RSA", "MD5-ECDSA", "DSA-SHA1"}
	if p.RejectSHA1 {
		algs = append(algs, "SHA1-RSA", "ECDSA-SHA1", "DSA-SHA256")
	}
	return algs
}

// RejectedKeyTypes lists key types that are not accepted at any strength.
func RejectedKeyTypes() []string {
	return []string{"DSA"}
}

// Evaluate returns one Violation per boundary the certificate crosses.
// An empty slice means the certificate is within the boundary.
func Evaluate(p Policy, cert *x509.Certificate) []Violation {
	var violations []Violation

	if reason, ok := signatureReason(p, cert.SignatureAlgorithm); !ok {
		violations = append(violations, Violation{Cert: cert, Reason: reason})
	}

	switch key := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		if bits := key.N.BitLen(); bits < p.MinRSABits {
			violations = append(violations, Violation{Cert: cert, Reason: fmt.Sprintf(
				"RSA key strength %d bits is below the minimum of %d bits",
				bits, p.MinRSABits)})
		}
	case *ecdsa.PublicKey:
		if bits := key.Params().BitSize; bits < p.MinECDSABits {
			violations = append(violations, Violation{Cert: cert, Reason: fmt.Sprintf(
				"ECDSA curve strength %d bits is below the minimum of %d bits",
				bits, p.MinECDSABits)})
		}
	case ed25519.PublicKey:
		// Ed25519 has a fixed ~128-bit strength and is accepted.
	case *dsa.PublicKey:
		violations = append(violations, Violation{Cert: cert, Reason: "DSA public keys are not accepted by the security policy"})
	default:
		violations = append(violations, Violation{Cert: cert, Reason: fmt.Sprintf(
			"unsupported public key type %T", cert.PublicKey)})
	}

	return violations
}

// signatureReason returns ok=false (with a human reason) when the signature
// algorithm is outside the boundary.
func signatureReason(p Policy, alg x509.SignatureAlgorithm) (string, bool) {
	switch alg {
	// Always rejected: broken hashes.
	case x509.MD2WithRSA:
		return "signature algorithm MD2-RSA is broken and not accepted", false
	case x509.MD5WithRSA:
		return "signature algorithm MD5-RSA is broken and not accepted", false
	case x509.SHA1WithRSA, x509.ECDSAWithSHA1, x509.DSAWithSHA1:
		if p.RejectSHA1 {
			return fmt.Sprintf("signature algorithm %s uses SHA-1, which is below the security boundary",
				alg.String()), false
		}
		return "", true
	// DSA with any hash is rejected via the key-type rule, and these algs have
	// no modern deployment; keep the boundary explicit.
	case x509.DSAWithSHA256:
		return "signature algorithm DSA-SHA256 is not accepted (DSA key type rejected)", false
	case x509.UnknownSignatureAlgorithm:
		return "certificate uses an unknown signature algorithm", false
	default:
		// SHA-256/SHA-384/SHA-512 with RSA, ECDSA and Ed25519.
		return "", true
	}
}
