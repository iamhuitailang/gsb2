// Package sigverify performs the purely cryptographic signature check on a
// certificate link: does the issuer's public key verify the signature over the
// child's TBS bytes? It deliberately uses x509.Certificate.CheckSignature,
// which validates signature mathematics without imposing Go's own algorithm
// deprecation policy. Whether an algorithm is acceptable is decided separately
// by the policy package, so a SHA-1 chain can still be built and then rejected
// with a precise policy reason instead of failing opaquely.
package sigverify

import (
	"crypto/x509"
	"fmt"
)

// Link reports whether parent's public key verifies child's signature. It does
// not evaluate algorithm strength; callers run policy checks for that.
//
// x509.Certificate.CheckSignature verifies using the *receiver's* public key,
// so the parent (the issuer) must be the receiver. The algorithm is the one
// the parent used to sign, which the child records in its SignatureAlgorithm;
// the two are required to match for a well-formed chain.
func Link(child, parent *x509.Certificate) error {
	if child == nil || parent == nil {
		return fmt.Errorf("nil certificate in signature check")
	}
	return parent.CheckSignature(child.SignatureAlgorithm, child.RawTBSCertificate, child.Signature)
}
