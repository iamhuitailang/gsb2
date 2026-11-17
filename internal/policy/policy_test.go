package policy_test

import (
	"testing"

	"gsb2/certverify/internal/policy"
	"gsb2/certverify/internal/testca"
)

func TestRSABoundary(t *testing.T) {
	root := testca.Root("RSA Root", testca.WithWeakRSA()) // RSA-1024
	v := policy.Evaluate(policy.Default(), root.Cert)
	if len(v) == 0 {
		t.Fatal("RSA-1024 must violate the default 2048-bit boundary")
	}
	found := false
	for _, viol := range v {
		if contains(viol.Reason, "1024") {
			found = true
		}
	}
	if !found {
		t.Fatalf("violation must name the key size, got %+v", v)
	}

	relaxed := policy.Policy{MinRSABits: 1024, MinECDSABits: 256, RejectSHA1: true}
	if got := policy.Evaluate(relaxed, root.Cert); len(got) != 0 {
		t.Fatalf("RSA-1024 under a 1024-bit boundary should pass, got %+v", got)
	}
}

func TestECDSABoundary(t *testing.T) {
	root := testca.Root("EC Root") // P-256, accepted by default
	if got := policy.Evaluate(policy.Default(), root.Cert); len(got) != 0 {
		t.Fatalf("P-256 should satisfy the default boundary, got %+v", got)
	}
	strict := policy.Policy{MinRSABits: 2048, MinECDSABits: 384, RejectSHA1: true}
	if got := policy.Evaluate(strict, root.Cert); len(got) == 0 {
		t.Fatal("P-256 must violate a 384-bit ECDSA boundary")
	}
}

func TestSHA1Boundary(t *testing.T) {
	root := testca.Root("SHA Root", testca.WithSHA1())
	if got := policy.Evaluate(policy.Default(), root.Cert); len(got) == 0 {
		t.Fatal("SHA-1 must be rejected by the default policy")
	}
	relaxed := policy.Policy{MinRSABits: 2048, MinECDSABits: 256, RejectSHA1: false}
	// With SHA-1 allowed, the only remaining checks are the (strong) key and
	// non-SHA1 rules, so the certificate should be clean.
	if got := policy.Evaluate(relaxed, root.Cert); len(got) != 0 {
		t.Fatalf("SHA-1 under an explicit opt-out should pass, got %+v", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
