package verify_test

import (
	"crypto/x509"
	"testing"
	"time"

	"gsb2/certverify/internal/chain"
	"gsb2/certverify/internal/policy"
	"gsb2/certverify/internal/report"
	"gsb2/certverify/internal/testca"
	"gsb2/certverify/internal/verify"
)

var verifyAt = time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

// harness bundles a typical root -> intermediate -> leaf hierarchy.
type harness struct {
	root  *testca.CA
	inter *testca.CA
	leaf  *x509.Certificate
}

func buildHarness(t *testing.T) harness {
	t.Helper()
	root := testca.Root("Test Root CA")
	inter := root.Intermediate("Test Intermediate CA", 1, false)
	leaf, _ := inter.Leaf("example.com", []string{"example.com", "www.example.com"})
	return harness{root: root, inter: inter, leaf: leaf}
}

func engineFor(t *testing.T, h harness, opts ...func(*verify.Options)) *verify.Engine {
	t.Helper()
	var interNodes []chain.Node
	if h.inter != nil {
		interNodes = []chain.Node{{Cert: h.inter.Cert, Source: "inter.pem", SourceIndex: 1}}
	}
	o := verify.Options{
		Time:          verifyAt,
		Hostname:      "example.com",
		Purposes:      []string{"serverauth"},
		Policy:        policy.Default(),
		Leaf:          h.leaf,
		Intermediates: interNodes,
		Roots:         []chain.Node{{Cert: h.root.Cert, Source: "root.pem", SourceIndex: 1, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			h.leaf:      report.NewCertRef(h.leaf, "leaf.pem", 1),
			h.root.Cert: report.NewCertRef(h.root.Cert, "root.pem", 1),
		},
	}
	if h.inter != nil {
		o.Refs[h.inter.Cert] = report.NewCertRef(h.inter.Cert, "inter.pem", 1)
	}
	for _, fn := range opts {
		fn(&o)
	}
	return verify.NewEngine(o)
}

func findCheck(res report.LeafResult, id string) *report.Check {
	for i := range res.Checks {
		if res.Checks[i].ID == id {
			return &res.Checks[i]
		}
	}
	return nil
}

func assertTrusted(t *testing.T, res report.LeafResult) {
	t.Helper()
	if res.Decision != report.StatusTrusted {
		t.Fatalf("expected TRUSTED, got %s: %s", res.Decision, res.Summary)
	}
}

func assertRejected(t *testing.T, res report.LeafResult) {
	t.Helper()
	if res.Decision != report.StatusTrusted {
		return
	}
	t.Fatalf("expected REJECTED but chain was trusted")
}

func assertCheck(t *testing.T, res report.LeafResult, id string, want report.CheckStatus) *report.Check {
	t.Helper()
	c := findCheck(res, id)
	if c == nil {
		t.Fatalf("check %q not present; have %v", id, checkIDs(res))
	}
	if c.Status != want {
		t.Fatalf("check %q = %s (%s), want %s", id, c.Status, c.Detail, want)
	}
	return c
}

func checkIDs(res report.LeafResult) []string {
	var ids []string
	for _, c := range res.Checks {
		ids = append(ids, c.ID)
	}
	return ids
}

func TestTrustedChain(t *testing.T) {
	h := buildHarness(t)
	res := engineFor(t, h).VerifyLeaf(h.leaf)
	assertTrusted(t, res)
	assertCheck(t, res, "chain.build", report.CheckPass)
	// One signature and one CA check for the intermediate, one for the root.
	sigCount, caCount := 0, 0
	for _, c := range res.Checks {
		switch c.ID {
		case "chain.signature":
			sigCount++
		case "chain.ca":
			caCount++
		}
	}
	if sigCount != 2 || caCount != 2 {
		t.Fatalf("expected 2 signature and 2 CA checks, got %d and %d", sigCount, caCount)
	}
	if len(res.SelectedChain) != 3 {
		t.Fatalf("expected chain of 3 certificates, got %d", len(res.SelectedChain))
	}
	if res.SelectedChain[0].Role != "leaf" ||
		res.SelectedChain[1].Role != "intermediate" ||
		res.SelectedChain[2].Role != "root" {
		t.Fatalf("unexpected chain roles: %+v", res.SelectedChain)
	}
}

func TestTrustedChainDirectlySignedByRoot(t *testing.T) {
	root := testca.Root("Direct Root CA")
	leaf, _ := root.Leaf("direct.example", []string{"direct.example"})
	o := verify.Options{
		Time:     verifyAt,
		Hostname: "direct.example",
		Purposes: []string{"serverauth"},
		Policy:   policy.Default(),
		Leaf:     leaf,
		Roots:    []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			leaf:      report.NewCertRef(leaf, "leaf.pem", 1),
			root.Cert: report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}
	res := verify.NewEngine(o).VerifyLeaf(leaf)
	assertTrusted(t, res)
	if len(res.SelectedChain) != 2 {
		t.Fatalf("expected 2-cert chain, got %d", len(res.SelectedChain))
	}
}

func TestUntrustedRoot(t *testing.T) {
	h := buildHarness(t)
	other := testca.Root("Unrelated Root CA")
	res := engineFor(t, h, func(o *verify.Options) {
		o.Roots = []chain.Node{{Cert: other.Cert, IsRoot: true}}
		o.Refs[other.Cert] = report.NewCertRef(other.Cert, "other.pem", 1)
	}).VerifyLeaf(h.leaf)
	assertRejected(t, res)
	assertCheck(t, res, "chain.build", report.CheckFail)
	if len(res.ChainAttempts) == 0 {
		t.Fatalf("expected failed chain attempts to be recorded")
	}
	if len(res.SelectedChain) != 0 {
		t.Fatalf("no chain should be selected for an untrusted root")
	}
}

func TestMissingIntermediate(t *testing.T) {
	h := buildHarness(t)
	res := engineFor(t, h, func(o *verify.Options) {
		o.Intermediates = nil
	}).VerifyLeaf(h.leaf)
	assertRejected(t, res)
	c := assertCheck(t, res, "chain.build", report.CheckFail)
	if c.Detail == "" {
		t.Fatalf("chain.build failure should explain the reason")
	}
}

func TestWrongHostname(t *testing.T) {
	h := buildHarness(t)
	res := engineFor(t, h, func(o *verify.Options) {
		o.Hostname = "evil.example.org"
	}).VerifyLeaf(h.leaf)
	assertRejected(t, res)
	c := assertCheck(t, res, "hostname", report.CheckFail)
	for _, ev := range c.Evidence {
		if ev == "evil.example.org" {
			t.Fatalf("rejected name must not appear as SAN evidence")
		}
	}
}

func TestHostnameWildcard(t *testing.T) {
	root := testca.Root("Wildcard Root")
	leaf, _ := root.Leaf("wild.example", []string{"*.example.com"})
	h := harness{root: root, leaf: leaf}
	res := engineFor(t, h, func(o *verify.Options) {
		o.Hostname = "api.example.com"
		o.Intermediates = nil
	}).VerifyLeaf(leaf)
	assertCheck(t, res, "hostname", report.CheckPass)

	// Wildcards match exactly one label, never multiple.
	res = engineFor(t, h, func(o *verify.Options) {
		o.Hostname = "a.b.example.com"
		o.Intermediates = nil
	}).VerifyLeaf(leaf)
	assertCheck(t, res, "hostname", report.CheckFail)
}

func TestCommonNameNotUsedWhenSANPresent(t *testing.T) {
	root := testca.Root("SAN Root")
	// CN matches the target but the SAN lists a different name.
	leaf, _ := root.Leaf("target.example", []string{"other.example"})
	h := harness{root: root, leaf: leaf}
	res := engineFor(t, h, func(o *verify.Options) {
		o.Hostname = "target.example"
		o.Intermediates = nil
	}).VerifyLeaf(leaf)
	assertRejected(t, res)
	c := assertCheck(t, res, "hostname", report.CheckFail)
	if !contains(c.Detail, "Common Name is ignored") {
		t.Fatalf("expected CN-ignored explanation, got: %s", c.Detail)
	}
}

func TestLegacyCNFallback(t *testing.T) {
	root := testca.Root("Legacy Root")
	// A leaf with a CN but no SAN extension.
	spec := testca.LeafSpec{
		Subject:     "legacy.example",
		NotBefore:   root.NotBefore,
		NotAfter:    root.NotAfter.AddDate(-1, 0, 0),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leaf, _ := root.IssueCert(spec, testca.KeyECDSAP256)

	run := func(allow bool) report.LeafResult {
		o := verify.Options{
			Time: verifyAt, Hostname: "legacy.example",
			Purposes: []string{"serverauth"}, Policy: policy.Default(),
			Leaf: leaf, Roots: []chain.Node{{Cert: root.Cert, IsRoot: true}},
			AllowLegacyCN: allow,
			Refs: map[*x509.Certificate]report.CertRef{
				leaf: report.NewCertRef(leaf, "leaf.pem", 1), root.Cert: report.NewCertRef(root.Cert, "root.pem", 1),
			},
		}
		return verify.NewEngine(o).VerifyLeaf(leaf)
	}
	c := assertCheck(t, run(false), "hostname", report.CheckFail)
	if !contains(c.Detail, "legacy Common Name matching is disabled") {
		t.Fatalf("unexpected detail: %s", c.Detail)
	}
	assertCheck(t, run(true), "hostname", report.CheckPass)
}

func TestValidityBoundaries(t *testing.T) {
	h := buildHarness(t)
	nb := h.leaf.NotBefore
	na := h.leaf.NotAfter

	cases := []struct {
		name string
		at   time.Time
		want report.CheckStatus
	}{
		{"one second before notBefore", nb.Add(-time.Second), report.CheckFail},
		{"exactly at notBefore", nb, report.CheckPass},
		{"inside the window", nb.Add(time.Hour), report.CheckPass},
		{"exactly at notAfter", na, report.CheckPass},
		{"one second after notAfter", na.Add(time.Second), report.CheckFail},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := engineFor(t, h, func(o *verify.Options) {
				o.Time = tc.at
			}).VerifyLeaf(h.leaf)
			assertCheck(t, res, "validity", tc.want)
			if tc.want == report.CheckFail {
				assertRejected(t, res)
			}
		})
	}
}

func TestPurposeMismatch(t *testing.T) {
	h := buildHarness(t)

	// Leaf valid only for client authentication, checked for server use.
	clientLeaf, _ := h.inter.Leaf("client.example", []string{"client.example"},
		testca.WithEKU(x509.ExtKeyUsageClientAuth))
	res := engineFor(t, harness{h.root, h.inter, clientLeaf}).VerifyLeaf(clientLeaf)
	assertRejected(t, res)
	assertCheck(t, res, "extended-key-usage", report.CheckFail)

	// Key usage lacking any bit the requested purpose needs.
	noKU, _ := h.inter.Leaf("noku.example", []string{"noku.example"},
		testca.WithKeyUsage(x509.KeyUsageCertSign))
	res = engineFor(t, harness{h.root, h.inter, noKU}).VerifyLeaf(noKU)
	assertCheck(t, res, "key-usage", report.CheckFail)

	// Purpose 'all' relaxes usage enforcement but keeps the rest of the chain.
	res = engineFor(t, h, func(o *verify.Options) {
		o.Purposes = []string{"all"}
	}).VerifyLeaf(h.leaf)
	assertTrusted(t, res)
	assertCheck(t, res, "extended-key-usage", report.CheckInfo)
}

func TestNonCAIssuer(t *testing.T) {
	// A non-CA certificate attempts to sign a leaf.
	h := buildHarness(t)
	nonCA, nonCAKey := h.inter.Leaf("not-a-ca.example", []string{"not-a-ca.example"})
	signer := &testca.CA{Cert: nonCA, Key: nonCAKey}
	rogue := h.inter.LeafSignedBy(signer, "rogue.example", []string{"rogue.example"})

	o := verify.Options{
		Time: verifyAt, Hostname: "rogue.example", Purposes: []string{"serverauth"},
		Policy: policy.Default(), Leaf: rogue,
		Intermediates: []chain.Node{{Cert: nonCA}},
		Roots:         []chain.Node{{Cert: h.root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			rogue:       report.NewCertRef(rogue, "leaf.pem", 1),
			nonCA:       report.NewCertRef(nonCA, "inter.pem", 1),
			h.root.Cert: report.NewCertRef(h.root.Cert, "root.pem", 1),
		},
	}
	res := verify.NewEngine(o).VerifyLeaf(rogue)
	assertRejected(t, res)
	if len(res.ChainAttempts) == 0 {
		t.Fatalf("expected the non-CA path to be recorded as a failed attempt")
	}
	found := false
	for _, a := range res.ChainAttempts {
		if contains(a.Failure, "not a CA") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a 'not a CA' failure reason, got: %+v", res.ChainAttempts)
	}
}

func TestPathLengthConstraint(t *testing.T) {
	// Root -> constrained intermediate (pathLen=0) -> second intermediate -> leaf.
	root := testca.Root("PathLen Root")
	first := root.Intermediate("Constrained CA", 0, true) // pathLen 0
	second := first.Intermediate("Second CA", 0, false)
	leaf, _ := second.Leaf("deep.example", []string{"deep.example"})

	o := verify.Options{
		Time: verifyAt, Hostname: "deep.example", Purposes: []string{"serverauth"},
		Policy: policy.Default(), Leaf: leaf,
		Intermediates: []chain.Node{
			{Cert: first.Cert}, {Cert: second.Cert},
		},
		Roots: []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			leaf:        report.NewCertRef(leaf, "leaf.pem", 1),
			first.Cert:  report.NewCertRef(first.Cert, "a.pem", 1),
			second.Cert: report.NewCertRef(second.Cert, "b.pem", 1),
			root.Cert:   report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}
	res := verify.NewEngine(o).VerifyLeaf(leaf)
	assertRejected(t, res)
	assertCheck(t, res, "chain.pathlen", report.CheckFail)

	// Same hierarchy without the second intermediate satisfies pathLen=0.
	shortLeaf, _ := first.Leaf("short.example", []string{"short.example"})
	o2 := verify.Options{
		Time: verifyAt, Hostname: "short.example", Purposes: []string{"serverauth"},
		Policy: policy.Default(), Leaf: shortLeaf,
		Intermediates: []chain.Node{{Cert: first.Cert}},
		Roots:         []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			shortLeaf:  report.NewCertRef(shortLeaf, "leaf.pem", 1),
			first.Cert: report.NewCertRef(first.Cert, "a.pem", 1),
			root.Cert:  report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}
	res2 := verify.NewEngine(o2).VerifyLeaf(shortLeaf)
	assertTrusted(t, res2)
}

func TestBrokenSignature(t *testing.T) {
	// Same subject/issuer names as the valid leaf, but with a flipped signature
	// byte so the issuer's public key can no longer verify it.
	h := buildHarness(t)
	tampered := testca.TamperSignature(h.leaf)
	res := engineFor(t, h, func(o *verify.Options) {
		o.Leaf = tampered
		o.Refs[tampered] = report.NewCertRef(tampered, "leaf.pem", 1)
	}).VerifyLeaf(tampered)
	assertRejected(t, res)
	if len(res.ChainAttempts) == 0 || !contains(res.ChainAttempts[0].Failure, "signature") {
		t.Fatalf("expected a signature failure attempt, got %+v", res.ChainAttempts)
	}
}

func TestWeakAlgorithmRejected(t *testing.T) {
	root := testca.Root("Weak Root", testca.WithWeakRSA())
	leaf, _ := root.Leaf("weak.example", []string{"weak.example"})
	o := verify.Options{
		Time: verifyAt, Hostname: "weak.example", Purposes: []string{"serverauth"},
		Policy: policy.Default(), Leaf: leaf,
		Roots: []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			leaf:      report.NewCertRef(leaf, "leaf.pem", 1),
			root.Cert: report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}
	res := verify.NewEngine(o).VerifyLeaf(leaf)
	assertRejected(t, res)

	// The weak key belongs to the root, so its algorithm-strength check fails;
	// the leaf can be perfectly strong while the chain as a whole is rejected.
	rootFP := report.Fingerprint(root.Cert)
	var rootAlgo *report.Check
	for i := range res.Checks {
		c := &res.Checks[i]
		if c.ID == "algorithm-strength" && c.Cert != nil && c.Cert.SHA256 == rootFP {
			rootAlgo = c
		}
	}
	if rootAlgo == nil {
		t.Fatal("no algorithm-strength check recorded for the weak root")
	}
	if rootAlgo.Status != report.CheckFail {
		t.Fatalf("root algorithm-strength = %s, want FAIL: %s", rootAlgo.Status, rootAlgo.Detail)
	}
	if !contains(rootAlgo.Detail, "1024") || !contains(rootAlgo.Detail, "2048") {
		t.Fatalf("failure must name the weak size and the boundary, got: %s", rootAlgo.Detail)
	}

	// A boundary relaxed to the key size accepts the whole chain.
	o.Policy = policy.Policy{MinRSABits: 1024, MinECDSABits: 256, RejectSHA1: true}
	res = verify.NewEngine(o).VerifyLeaf(leaf)
	assertTrusted(t, res)
}

func TestSHA1Rejected(t *testing.T) {
	root := testca.Root("SHA1 Root", testca.WithSHA1())
	leaf, _ := root.Leaf("sha1.example", []string{"sha1.example"})
	base := verify.Options{
		Time: verifyAt, Hostname: "sha1.example", Purposes: []string{"serverauth"},
		Leaf:  leaf,
		Roots: []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			leaf:      report.NewCertRef(leaf, "leaf.pem", 1),
			root.Cert: report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}

	// Default policy rejects SHA-1; the chain still builds (signature math is
	// valid) so the policy check can name the offending algorithm.
	base.Policy = policy.Default()
	res := verify.NewEngine(base).VerifyLeaf(leaf)
	assertRejected(t, res)
	foundSHA1 := false
	for _, c := range res.Checks {
		if c.ID == "algorithm-strength" && c.Status == report.CheckFail &&
			contains(c.Detail, "SHA-1") {
			foundSHA1 = true
		}
	}
	if !foundSHA1 {
		t.Fatalf("expected an algorithm-strength failure naming SHA-1, got: %s", res.Summary)
	}

	// With the SHA-1 boundary relaxed, the same chain is accepted.
	base.Policy = policy.Policy{MinRSABits: 2048, MinECDSABits: 256, RejectSHA1: false}
	res = verify.NewEngine(base).VerifyLeaf(leaf)
	assertTrusted(t, res)
}

func TestIntermediateEKUNesting(t *testing.T) {
	root := testca.Root("EKU Root")
	interSpec := testca.LeafSpec{
		Subject:     "CodeSign Restricted CA",
		NotBefore:   root.NotBefore,
		NotAfter:    root.NotAfter.AddDate(-1, 0, 0),
		KeyUsage:    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:        true,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
	}
	inter, interKey := root.IssueCert(interSpec, testca.KeyECDSAP256)
	interCA := &testca.CA{Cert: inter, Key: interKey, NotBefore: root.NotBefore, NotAfter: root.NotAfter}
	leaf, _ := interCA.Leaf("cs.example", []string{"cs.example"})

	o := verify.Options{
		Time: verifyAt, Hostname: "cs.example", Purposes: []string{"serverauth"},
		Policy: policy.Default(), Leaf: leaf,
		Intermediates: []chain.Node{{Cert: inter}},
		Roots:         []chain.Node{{Cert: root.Cert, IsRoot: true}},
		Refs: map[*x509.Certificate]report.CertRef{
			leaf:      report.NewCertRef(leaf, "leaf.pem", 1),
			inter:     report.NewCertRef(inter, "inter.pem", 1),
			root.Cert: report.NewCertRef(root.Cert, "root.pem", 1),
		},
	}
	res := verify.NewEngine(o).VerifyLeaf(leaf)
	assertRejected(t, res)
	assertCheck(t, res, "chain.eku", report.CheckFail)
}

func TestDeterministicOrdering(t *testing.T) {
	h := buildHarness(t)
	first := engineFor(t, h).VerifyLeaf(h.leaf)
	second := engineFor(t, h).VerifyLeaf(h.leaf)
	// Repeated runs produce identical check ordering and chain selection.
	if len(first.Checks) != len(second.Checks) {
		t.Fatalf("check count differs across runs")
	}
	for i := range first.Checks {
		if first.Checks[i].ID != second.Checks[i].ID {
			t.Fatalf("check order differs at %d: %s vs %s",
				i, first.Checks[i].ID, second.Checks[i].ID)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
