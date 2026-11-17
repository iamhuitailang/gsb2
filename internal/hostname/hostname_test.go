package hostname_test

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"net"
	"testing"

	"gsb2/certverify/internal/hostname"
)

func certWith(dns []string, ips []string, cn string) *x509.Certificate {
	c := &x509.Certificate{Subject: pkix.Name{CommonName: cn}, DNSNames: dns}
	for _, s := range ips {
		if ip := net.ParseIP(s); ip != nil {
			c.IPAddresses = append(c.IPAddresses, ip)
		}
	}
	return c
}

func TestDNSExactAndWildcard(t *testing.T) {
	c := certWith([]string{"example.com", "*.example.com"}, nil, "ignored.example")
	if !hostname.Verify(c, "example.com", false).Matched {
		t.Fatal("exact SAN should match")
	}
	if !hostname.Verify(c, "api.example.com", false).Matched {
		t.Fatal("wildcard SAN should match one label")
	}
	if hostname.Verify(c, "a.b.example.com", false).Matched {
		t.Fatal("wildcard must not match multiple labels")
	}
	if hostname.Verify(c, "other.org", false).Matched {
		t.Fatal("unrelated name must not match")
	}
}

func TestSANSuppressesCommonName(t *testing.T) {
	c := certWith([]string{"san.example"}, nil, "cn.example")
	r := hostname.Verify(c, "cn.example", true)
	if r.Matched {
		t.Fatal("CN must not be consulted while a SAN extension is present")
	}
	if r.CNUsed {
		t.Fatal("CNUsed must be false when a SAN exists")
	}
}

func TestLegacyCNOnlyWhenOptedIn(t *testing.T) {
	c := certWith(nil, nil, "legacy.example")
	if hostname.Verify(c, "legacy.example", false).Matched {
		t.Fatal("CN fallback must be off by default")
	}
	r := hostname.Verify(c, "legacy.example", true)
	if !r.Matched || !r.CNUsed {
		t.Fatal("CN fallback should match under explicit opt-in")
	}
}

func TestIPAddresses(t *testing.T) {
	c := certWith(nil, []string{"192.0.2.10", "2001:db8::1"}, "192.0.2.10")
	if !hostname.Verify(c, "192.0.2.10", false).Matched {
		t.Fatal("IPv4 SAN should match")
	}
	if !hostname.Verify(c, "2001:db8::1", false).Matched {
		t.Fatal("IPv6 SAN should match")
	}
	r := hostname.Verify(c, "192.0.2.99", false)
	if r.Matched {
		t.Fatal("absent IP must not match")
	}
	// A target IP never falls back to a CN even if the CN looks like an IP.
	c2 := certWith(nil, nil, "192.0.2.10")
	if hostname.Verify(c2, "192.0.2.10", true).Matched {
		t.Fatal("IP target must never use the Common Name")
	}
}

func TestEmptyNameSkipsCheck(t *testing.T) {
	c := certWith(nil, nil, "anything.example")
	if !hostname.Verify(c, "", false).Matched {
		t.Fatal("empty target name should skip the check")
	}
}
