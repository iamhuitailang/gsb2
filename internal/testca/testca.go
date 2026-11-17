// Package testca builds deterministic, in-memory test certificates. Nothing
// here touches the network or the operating system trust store, and no
// generated material is sensitive.
package testca

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

// detRand is a deterministic, cryptographically uniform byte stream:
// SHA-256 in counter mode over a per-entity seed. The uniform output keeps
// RSA primality testing efficient (a simple LCG does not), while the fixed
// seed keeps every generated key and certificate reproducible.
type detRand struct {
	seed    []byte
	counter uint64
	buf     []byte
}

func newDetRand(seed byte) *detRand {
	return &detRand{seed: []byte{seed}}
}

func (d *detRand) Read(p []byte) (int, error) {
	filled := 0
	for filled < len(p) {
		if len(d.buf) == 0 {
			var block [32]byte
			h := sha256.New()
			h.Write(d.seed)
			var ctr [8]byte
			binary.BigEndian.PutUint64(ctr[:], d.counter)
			h.Write(ctr[:])
			block = [32]byte(h.Sum(nil))
			d.counter++
			d.buf = block[:]
		}
		n := copy(p[filled:], d.buf)
		d.buf = d.buf[n:]
		filled += n
	}
	return len(p), nil
}

// genCounter ensures distinct keys even for certificates with identical names.
var genCounter uint32

// seedFor derives a unique, reproducible RNG seed for one generated entity.
func seedFor(name string) byte {
	genCounter++
	s := byte(genCounter*31 + 1)
	for _, c := range name {
		s = s*17 + byte(c)
	}
	return s
}

// CA is a parsed CA certificate together with its signer and generation
// parameters, ready to issue further certificates.
type CA struct {
	Cert       *x509.Certificate
	Key        interface{}
	IsRoot     bool
	NotBefore  time.Time
	NotAfter   time.Time
	LeafSpecs  LeafSpec // retained for re-issue helpers
	SerialSeed *big.Int
}

// LeafSpec describes a leaf or CA certificate to be generated.
type LeafSpec struct {
	Subject       string
	DNSNames      []string
	IPAddresses   []string
	NotBefore     time.Time
	NotAfter      time.Time
	KeyUsage      x509.KeyUsage
	ExtKeyUsage   []x509.ExtKeyUsage
	IsCA          bool
	MaxPathLen    int
	PathLenZero   bool
	SignatureAlgo x509.SignatureAlgorithm
}

// KeyType selects the generated key pair.
type KeyType string

const (
	KeyECDSAP256 KeyType = "ecdsa-p256"
	KeyRSA2048   KeyType = "rsa-2048"
	KeyRSA1024   KeyType = "rsa-1024" // weak, used to exercise the policy boundary
)

// RootOption mutates a root CA specification.
type RootOption func(*LeafSpec, *KeyType)

// WithWeakRSA generates an RSA-1024 root for policy-boundary tests.
func WithWeakRSA() RootOption {
	return func(_ *LeafSpec, kt *KeyType) { *kt = KeyRSA1024 }
}

// WithSHA1 makes the generated root use a SHA-1 signature. Modern Go rejects
// SHA-1 only in its high-level verification API; here the certificate is built
// at the ASN.1 level so the chain still constructs and the tool's own policy
// layer is what rejects (or, with --allow-sha1, accepts) it.
func WithSHA1() RootOption {
	return func(s *LeafSpec, _ *KeyType) { s.SignatureAlgo = x509.SHA1WithRSA }
}

// WithValidity overrides the validity window.
func WithValidity(notBefore, notAfter time.Time) RootOption {
	return func(s *LeafSpec, _ *KeyType) {
		s.NotBefore, s.NotAfter = notBefore, notAfter
	}
}

// normalize reconciles the requested signature algorithm with a compatible key
// type so generated certificates always satisfy x509.CreateCertificate's
// key/algorithm checks. The certificate's own public key type must match its
// signature algorithm; when the spec leaves the algorithm unset, the issuer's
// algorithm is inherited and the key type follows it. parent is the issuing
// certificate (nil for a self-signed root).
func normalize(spec LeafSpec, kt KeyType, parent *x509.Certificate) (LeafSpec, KeyType) {
	// 1. Determine the effective signature algorithm. An explicit algorithm on
	// the spec wins; otherwise inherit the issuer's algorithm, otherwise derive
	// one from the key type.
	if spec.SignatureAlgo == 0 {
		switch {
		case parent != nil:
			spec.SignatureAlgo = parent.SignatureAlgorithm
		case kt == KeyRSA2048 || kt == KeyRSA1024:
			spec.SignatureAlgo = x509.SHA256WithRSA
		default:
			spec.SignatureAlgo = x509.ECDSAWithSHA256
		}
	}

	// 2. Make the key type follow the algorithm family. An explicit weak-RSA
	// key choice is preserved.
	switch spec.SignatureAlgo {
	case x509.SHA1WithRSA, x509.MD5WithRSA, x509.MD2WithRSA,
		x509.SHA256WithRSA, x509.SHA384WithRSA, x509.SHA512WithRSA:
		if kt != KeyRSA1024 {
			kt = KeyRSA2048
		}
	default:
		kt = KeyECDSAP256
	}
	return spec, kt
}

// Root generates a self-signed root CA.
func Root(name string, opts ...RootOption) *CA {
	notBefore := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	spec := LeafSpec{
		Subject:   name,
		NotBefore: notBefore,
		NotAfter:  notBefore.AddDate(10, 0, 0),
		KeyUsage:  x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:      true,
		// SignatureAlgo left zero: normalize selects it from the key type,
		// unless an option (e.g. WithSHA1) overrides it.
	}
	kt := KeyECDSAP256
	for _, opt := range opts {
		opt(&spec, &kt)
	}
	spec, kt = normalize(spec, kt, nil)
	key := genKey(kt, seedFor(spec.Subject))
	serial := serialFor(name)
	tmpl := template(spec, serial)

	var der []byte
	var err error
	if spec.SignatureAlgo == x509.SHA1WithRSA {
		// The high-level API refuses to sign with SHA-1. Construct the
		// self-signed certificate at the ASN.1 level so the policy layer can be
		// exercised against a real, cryptographically verifiable SHA-1 cert.
		der, err = createSelfSignedSHA1(&tmpl, key.(*rsa.PrivateKey))
	} else {
		der, err = x509.CreateCertificate(newDetRand(1), &tmpl, &tmpl, publicKey(key), key)
	}
	if err != nil {
		panic("testca: root creation failed: " + err.Error())
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		panic("testca: root parse failed: " + err.Error())
	}
	return &CA{Cert: cert, Key: key, IsRoot: true,
		NotBefore: spec.NotBefore, NotAfter: spec.NotAfter, SerialSeed: serial}
}

// Intermediate issues an intermediate CA from this CA.
func (ca *CA) Intermediate(name string, maxPathLen int, pathLenZero bool) *CA {
	spec := LeafSpec{
		Subject:     name,
		NotBefore:   ca.NotBefore,
		NotAfter:    ca.NotAfter.AddDate(-1, 0, 0),
		KeyUsage:    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:        true,
		MaxPathLen:  maxPathLen,
		PathLenZero: pathLenZero,
	}
	cert, key := ca.create(spec, KeyECDSAP256, nil, nil)
	return &CA{Cert: cert, Key: key, IsRoot: false,
		NotBefore: spec.NotBefore, NotAfter: spec.NotAfter, SerialSeed: serialFor(name)}
}

// IssueOptions mutates a leaf certificate before issuance.
type IssueOption func(*LeafSpec, *KeyType)

// WithEKU sets the leaf extended key usages.
func WithEKU(usages ...x509.ExtKeyUsage) IssueOption {
	return func(s *LeafSpec, _ *KeyType) { s.ExtKeyUsage = usages }
}

// WithKeyUsage sets the leaf key usage bits.
func WithKeyUsage(usage x509.KeyUsage) IssueOption {
	return func(s *LeafSpec, _ *KeyType) { s.KeyUsage = usage }
}

// WithLeafWeakRSA gives the leaf an RSA-1024 key.
func WithLeafWeakRSA() IssueOption {
	return func(_ *LeafSpec, kt *KeyType) { *kt = KeyRSA1024 }
}

// WithLeafSHA1 makes the leaf use a SHA-1 signature.
func WithLeafSHA1() IssueOption {
	return func(s *LeafSpec, _ *KeyType) { s.SignatureAlgo = x509.SHA1WithRSA }
}

// WithLeafValidity overrides the leaf validity window.
func WithLeafValidity(notBefore, notAfter time.Time) IssueOption {
	return func(s *LeafSpec, _ *KeyType) {
		s.NotBefore, s.NotAfter = notBefore, notAfter
	}
}

// Leaf issues an end-entity certificate from this CA.
func (ca *CA) Leaf(name string, dnsNames []string, opts ...IssueOption) (*x509.Certificate, interface{}) {
	spec := LeafSpec{
		Subject:     name,
		DNSNames:    dnsNames,
		NotBefore:   ca.NotBefore,
		NotAfter:    ca.NotAfter.AddDate(-1, 0, 0),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	kt := KeyECDSAP256
	for _, opt := range opts {
		opt(&spec, &kt)
	}
	cert, key := ca.create(spec, kt, nil, nil)
	return cert, key
}

// LeafSignedBy issues a leaf signed by an arbitrary signer rather than this
// CA, enabling tests where a non-CA entity signs a certificate.
func (ca *CA) LeafSignedBy(signer *CA, name string, dnsNames []string) *x509.Certificate {
	spec := LeafSpec{
		Subject:     name,
		DNSNames:    dnsNames,
		NotBefore:   ca.NotBefore,
		NotAfter:    ca.NotAfter.AddDate(-1, 0, 0),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	cert, _ := ca.create(spec, KeyECDSAP256, nil, signer)
	return cert
}

// IssueCert exposes the generic certificate creation path for tests that need
// a specification not covered by the Leaf/Intermediate helpers, e.g. an
// intermediate carrying a specific EKU.
func (ca *CA) IssueCert(spec LeafSpec, kt KeyType) (*x509.Certificate, interface{}) {
	return ca.create(spec, kt, nil, nil)
}

// create runs the generic x509 creation path. An explicit public key or
// signer overrides the generated defaults.
func (ca *CA) create(spec LeafSpec, kt KeyType, explicitPub interface{}, signer *CA) (*x509.Certificate, interface{}) {
	parent := ca.Cert
	if signer != nil {
		parent = signer.Cert
	}
	spec, kt = normalize(spec, kt, parent)
	key := genKey(kt, seedFor(spec.Subject))
	serial := serialFor(spec.Subject)
	tmpl := template(spec, serial)

	pub := explicitPub
	if pub == nil {
		pub = publicKey(key)
	}
	signingKey := ca.Key
	if signer != nil {
		signingKey = signer.Key
	}

	var (
		der []byte
		err error
	)
	if spec.SignatureAlgo == x509.SHA1WithRSA {
		rsaPub, ok := pub.(*rsa.PublicKey)
		if !ok {
			panic("testca: SHA-1 signing requires an RSA subject key")
		}
		rsaSigner, ok := signingKey.(*rsa.PrivateKey)
		if !ok {
			panic("testca: SHA-1 signing requires an RSA issuer key")
		}
		der, err = createSignedSHA1(&tmpl, parent, rsaPub, rsaSigner)
	} else {
		der, err = x509.CreateCertificate(newDetRand(3), &tmpl, parent, pub, signingKey)
	}
	if err != nil {
		panic("testca: certificate creation failed: " + err.Error())
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		panic("testca: certificate parse failed: " + err.Error())
	}
	return cert, key
}

func template(spec LeafSpec, serial *big.Int) x509.Certificate {
	return x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   spec.Subject,
			Organization: []string{"gsb2 offline test"},
		},
		NotBefore:             spec.NotBefore,
		NotAfter:              spec.NotAfter,
		KeyUsage:              spec.KeyUsage,
		ExtKeyUsage:           spec.ExtKeyUsage,
		BasicConstraintsValid: true,
		IsCA:                  spec.IsCA,
		MaxPathLen:            spec.MaxPathLen,
		MaxPathLenZero:        spec.PathLenZero,
		DNSNames:              spec.DNSNames,
		SignatureAlgorithm:    spec.SignatureAlgo,
	}
}

func genKey(kt KeyType, seed byte) interface{} {
	reader := newDetRand(seed)
	switch kt {
	case KeyRSA2048, KeyRSA1024:
		bits := 2048
		if kt == KeyRSA1024 {
			bits = 1024
		}
		key, err := rsa.GenerateKey(reader, bits)
		if err != nil {
			panic("testca: rsa key generation failed: " + err.Error())
		}
		return key
	default:
		key, err := ecdsa.GenerateKey(elliptic.P256(), reader)
		if err != nil {
			panic("testca: ecdsa key generation failed: " + err.Error())
		}
		return key
	}
}

func publicKey(key interface{}) interface{} {
	switch k := key.(type) {
	case *rsa.PrivateKey:
		return &k.PublicKey
	case *ecdsa.PrivateKey:
		return &k.PublicKey
	default:
		panic("testca: unsupported key type")
	}
}

func serialFor(name string) *big.Int {
	genCounter++
	// Accumulate in big.Int: a fixed-width integer would overflow for long
	// names and produce a negative serial, which x509 rejects.
	n := new(big.Int).SetInt64(int64(genCounter))
	for _, c := range name {
		n.Mul(n, big.NewInt(31))
		n.Add(n, big.NewInt(int64(c)))
	}
	return n
}

// algorithmIdentifierPKCS1v15 is the sha1-with-RSA signature OID 1.2.840.113549.1.1.5.
var algorithmIdentifierPKCS1v15 = pkix.AlgorithmIdentifier{
	Algorithm: asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 5},
}

// tbsCertificate mirrors the ASN.1 layout of RFC 5280 TBSCertificate so a
// reference certificate can be re-marshalled with a replaced signature OID.
type tbsCertificate struct {
	Raw                asn1.RawContent
	Version            int `asn1:"optional,explicit,default:0,tag:0"`
	SerialNumber       *big.Int
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Issuer             asn1.RawValue
	Validity           validity
	Subject            asn1.RawValue
	PublicKey          publicKeyInfo
	UniqueID           asn1.BitString   `asn1:"optional,tag:1"`
	SubjectUniqueID    asn1.BitString   `asn1:"optional,tag:2"`
	Extensions         []pkix.Extension `asn1:"optional,explicit,tag:3"`
}

type validity struct {
	NotBefore, NotAfter time.Time
}

type publicKeyInfo struct {
	Raw       asn1.RawContent
	Algorithm pkix.AlgorithmIdentifier
	PublicKey asn1.BitString
}

type certificate struct {
	Raw                asn1.RawContent
	TBSCertificate     tbsCertificate
	SignatureAlgorithm pkix.AlgorithmIdentifier
	SignatureValue     asn1.BitString
}

// reSignSHA1 takes an already valid, standard-library-built certificate (ref)
// and re-issues it with a SHA-1 signature by parentKey, preserving every
// extension exactly as encoded (basic constraints, SAN, key usage, ...).
// The high-level API cannot sign with SHA-1, so the signature is produced with
// rsa.SignPKCS1v15 and the DER Certificate is reassembled here.
func reSignSHA1(ref *x509.Certificate, parentKey *rsa.PrivateKey) ([]byte, error) {
	// Decode the reference TBS into the editable structure.
	var tbs tbsCertificate
	if _, err := asn1.Unmarshal(ref.RawTBSCertificate, &tbs); err != nil {
		return nil, fmt.Errorf("decode reference TBS: %w", err)
	}
	// Replace both the inner and outer signature algorithm identifiers.
	tbs.SignatureAlgorithm = algorithmIdentifierPKCS1v15
	tbs.Raw = nil // force re-marshalling
	tbsBytes, err := asn1.Marshal(tbs)
	if err != nil {
		return nil, err
	}

	hashed := sha1.Sum(tbsBytes)
	sig, err := rsa.SignPKCS1v15(rand.Reader, parentKey, crypto.SHA1, hashed[:])
	if err != nil {
		return nil, err
	}

	cert := certificate{
		TBSCertificate:     tbs,
		SignatureAlgorithm: algorithmIdentifierPKCS1v15,
		SignatureValue:     asn1.BitString{Bytes: sig, BitLength: len(sig) * 8},
	}
	return asn1.Marshal(cert)
}

// createSignedSHA1 builds a reference certificate with the supported SHA-256
// algorithm, then re-signs it as SHA-1 so all standard extensions are retained.
func createSignedSHA1(tmpl *x509.Certificate, parent *x509.Certificate,
	subjectPublic *rsa.PublicKey, parentKey *rsa.PrivateKey) ([]byte, error) {

	// Build the reference with a supported algorithm so every extension is
	// generated exactly as the standard library would encode it; the signature
	// algorithm OID is then swapped to SHA-1 and the bytes re-signed.
	refTmpl := *tmpl
	refTmpl.SignatureAlgorithm = x509.SHA256WithRSA
	refDER, err := x509.CreateCertificate(newDetRand(9), &refTmpl, parent, subjectPublic, parentKey)
	if err != nil {
		return nil, err
	}
	ref, err := x509.ParseCertificate(refDER)
	if err != nil {
		return nil, err
	}
	return reSignSHA1(ref, parentKey)
}

// createSelfSignedSHA1 builds a self-signed SHA-1-with-RSA root certificate.
func createSelfSignedSHA1(tmpl *x509.Certificate, key *rsa.PrivateKey) ([]byte, error) {
	return createSignedSHA1(tmpl, tmpl, &key.PublicKey, key)
}
func PEMEncode(certs ...*x509.Certificate) []byte {
	var out []byte
	for _, c := range certs {
		block := &pem.Block{Type: "CERTIFICATE", Bytes: c.Raw}
		out = append(out, pem.EncodeToMemory(block)...)
	}
	return out
}

// CorruptPEM flips a byte in the DER payload of an otherwise valid PEM block.
func CorruptPEM(cert *x509.Certificate) []byte {
	raw := append([]byte(nil), cert.Raw...)
	raw[len(raw)/2] ^= 0xFF
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})
}

// TamperedSignaturePEM rewrites the signature bytes so cryptographic
// verification fails while the certificate still parses.
func TamperedSignaturePEM(cert *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: TamperSignature(cert).Raw})
}

// TamperSignature flips a byte inside the certificate signature BIT STRING and
// returns a re-parsed copy whose subject and issuer are unchanged but whose
// signature no longer verifies.
func TamperSignature(cert *x509.Certificate) *x509.Certificate {
	raw := append([]byte(nil), cert.Raw...)
	// The signature is the last field of a DER Certificate; flip a byte near
	// the end of the buffer, inside the signature BIT STRING.
	raw[len(raw)-3] ^= 0x01
	tampered, err := x509.ParseCertificate(raw)
	if err != nil {
		panic("testca: tampered certificate failed to re-parse: " + err.Error())
	}
	return tampered
}
