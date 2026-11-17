package chain_test

import (
	"crypto/x509"
	"testing"
	"time"

	"gsb2/certverify/internal/chain"
	"gsb2/certverify/internal/testca"
)

func node(c *x509.Certificate, root bool) chain.Node {
	return chain.Node{Cert: c, IsRoot: root}
}

func TestBuildFullChain(t *testing.T) {
	root := testca.Root("Chain Root")
	inter := root.Intermediate("Chain Inter", 1, false)
	leaf, _ := inter.Leaf("chain.example", []string{"chain.example"})

	b := chain.NewBuilder(
		[]chain.Node{node(inter.Cert, false)},
		[]chain.Node{node(root.Cert, true)},
	)
	chains, attempts := b.Build(leaf)
	if len(attempts) != 0 {
		t.Fatalf("expected no failed attempts, got %+v", attempts)
	}
	if len(chains) != 1 {
		t.Fatalf("expected one chain, got %d", len(chains))
	}
	if len(chains[0].Certs) != 3 {
		t.Fatalf("expected 3-cert chain, got %d", len(chains[0].Certs))
	}
}

func TestBuildRejectsUnknownIssuer(t *testing.T) {
	root := testca.Root("Root A")
	other := testca.Root("Root B")
	inter := root.Intermediate("Inter A", 1, false)
	leaf, _ := inter.Leaf("a.example", []string{"a.example"})

	b := chain.NewBuilder(
		[]chain.Node{node(inter.Cert, false)},
		[]chain.Node{node(other.Cert, true)},
	)
	chains, attempts := b.Build(leaf)
	if len(chains) != 0 {
		t.Fatal("no chain should reach an unrelated trust root")
	}
	if len(attempts) == 0 {
		t.Fatal("a failed attempt must explain why no anchor was found")
	}
}

func TestBuildRejectsNonCAIntermediate(t *testing.T) {
	root := testca.Root("NCA Root")
	inter := root.Intermediate("NCA Inter", 1, false)
	nonCA, nonCAKey := inter.Leaf("nonca.example", []string{"nonca.example"})
	rogue := inter.LeafSignedBy(
		&testca.CA{Cert: nonCA, Key: nonCAKey}, "rogue.example", []string{"rogue.example"})

	b := chain.NewBuilder(
		[]chain.Node{node(inter.Cert, false), node(nonCA, false)},
		[]chain.Node{node(root.Cert, true)},
	)
	chains, attempts := b.Build(rogue)
	if len(chains) != 0 {
		t.Fatal("a path through a non-CA issuer must not complete")
	}
	found := false
	for _, a := range attempts {
		if contains(a.Failure, "not a CA") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a not-a-CA failure, got %+v", attempts)
	}
}

func TestBuildDetectsIssuerCycle(t *testing.T) {
	// Two CAs that cross-issue would loop; the builder must terminate. Here we
	// simply assert a self-referential intermediate cannot hang construction.
	root := testca.Root("Cycle Root")
	inter := root.Intermediate("Cycle Inter", 2, false)
	leaf, _ := inter.Leaf("cycle.example", []string{"cycle.example"})

	b := chain.NewBuilder(
		[]chain.Node{node(inter.Cert, false), node(inter.Cert, false)},
		[]chain.Node{node(root.Cert, true)},
	)
	done := make(chan struct{})
	go func() {
		b.Build(leaf)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("chain building did not terminate (possible issuer cycle)")
	}
}

func TestCheckPathLength(t *testing.T) {
	root := testca.Root("PL Root")
	first := root.Intermediate("PL First", 0, true) // pathLen=0
	second := first.Intermediate("PL Second", 0, false)
	leaf, _ := second.Leaf("pl.example", []string{"pl.example"})

	full := []*x509.Certificate{leaf, second.Cert, first.Cert, root.Cert}
	if _, ok := chain.CheckPathLength(full); ok {
		t.Fatal("pathLen=0 must be violated when an intermediate sits below the CA")
	}
	short := []*x509.Certificate{leaf, first.Cert, root.Cert}
	if _, ok := chain.CheckPathLength(short); !ok {
		t.Fatal("a leaf directly under a pathLen=0 CA must satisfy the constraint")
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
