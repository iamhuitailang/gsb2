// Command certverify is an offline certificate chain verification tool.
//
// It never contacts the network, never reads the operating system trust
// store, and only trusts roots explicitly supplied with --root. Verification
// failures are reported through exit code 3; every other non-zero code is an
// operational error of a distinct kind, so a rejected certificate is never
// mistaken for a tool crash.
package main

import (
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"gsb2/certverify/internal/certload"
	"gsb2/certverify/internal/chain"
	"gsb2/certverify/internal/policy"
	"gsb2/certverify/internal/render"
	"gsb2/certverify/internal/report"
	"gsb2/certverify/internal/verify"
)

const toolVersion = "1.0.0"

// Distinct exit codes, documented in the README.
const (
	exitOK               = 0
	exitUsage            = 2
	exitFileError        = 3
	exitCertInputError   = 4
	exitVerificationFail = 5
	exitInternal         = 6
)

// stringList is a repeatable flag value, e.g. --leaf a.pem --leaf b.pem.
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	if v == "" {
		return errors.New("value must not be empty")
	}
	*s = append(*s, v)
	return nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr *os.File) int {
	fs := flag.NewFlagSet("certverify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { usage(fs) }

	var leaves, intermediates, roots stringList
	fs.Var(&leaves, "leaf", "file containing the leaf certificate(s) (repeatable)")
	fs.Var(&intermediates, "intermediate", "file containing intermediate certificate(s) (repeatable)")
	fs.Var(&roots, "root", "file containing trusted root certificate(s) (repeatable, required)")

	hostname := fs.String("hostname", "", "target DNS name or IP address to verify against the leaf")
	purposeFlag := fs.String("purpose", "serverauth",
		"comma-separated intended purpose(s): serverauth,clientauth,codesigning,email,all")
	atTime := fs.String("time", "", "verification time as RFC3339 or YYYY-MM-DD (default: now)")
	format := fs.String("format", "text", "output format: text|json")
	output := fs.String("output", "", "write output to this file instead of stdout")
	allowLegacyCN := fs.Bool("allow-legacy-cn", false,
		"allow Common Name fallback for certificates without a SAN extension")
	minRSA := fs.Int("min-rsa-bits", 2048, "minimum accepted RSA key size in bits")
	minECDSA := fs.Int("min-ecdsa-bits", 256, "minimum accepted ECDSA curve size in bits")
	allowSHA1 := fs.Bool("allow-sha1", false, "accept SHA-1 based signature algorithms (default: reject)")

	if err := fs.Parse(args); err != nil {
		return exitUsage
	}

	*format = strings.ToLower(*format)
	if *format != "text" && *format != "json" {
		fmt.Fprintf(stderr, "error: --format must be text or json, got %q\n", *format)
		return exitUsage
	}
	if len(leaves) == 0 {
		fmt.Fprintln(stderr, "error: at least one --leaf file is required")
		return exitUsage
	}
	if len(roots) == 0 {
		fmt.Fprintln(stderr, "error: at least one --root file is required; the system trust store is never used")
		return exitUsage
	}
	purposes, err := parsePurposes(*purposeFlag)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return exitUsage
	}
	verifyTime, err := parseTime(*atTime)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return exitUsage
	}

	// All input files are read and parsed before any verification runs.
	leafLoad, code := loadPool(stderr, leaves, "leaf")
	if code != exitOK {
		return code
	}
	intermediateLoad, code := loadPool(stderr, intermediates, "intermediate")
	if code != exitOK {
		return code
	}
	rootLoad, code := loadPool(stderr, roots, "root")
	if code != exitOK {
		return code
	}
	if len(rootLoad.Certs) == 0 {
		fmt.Fprintln(stderr, "error: no usable trust root certificates were supplied")
		return exitCertInputError
	}

	pol := policy.Policy{
		MinRSABits:   *minRSA,
		MinECDSABits: *minECDSA,
		RejectSHA1:   !*allowSHA1,
	}

	refs := make(map[*x509.Certificate]report.CertRef)
	allLoaded := make([]certload.LoadedCert, 0,
		len(leafLoad.Certs)+len(intermediateLoad.Certs)+len(rootLoad.Certs))
	allLoaded = append(allLoaded, leafLoad.Certs...)
	allLoaded = append(allLoaded, intermediateLoad.Certs...)
	allLoaded = append(allLoaded, rootLoad.Certs...)
	for _, lc := range allLoaded {
		refs[lc.Cert] = report.NewCertRef(lc.Cert, lc.Source, lc.SourceIndex)
	}

	interNodes := make([]chain.Node, 0, len(intermediateLoad.Certs))
	for _, lc := range intermediateLoad.Certs {
		interNodes = append(interNodes, chain.Node{
			Cert: lc.Cert, Source: lc.Source, SourceIndex: lc.SourceIndex,
		})
	}
	rootNodes := make([]chain.Node, 0, len(rootLoad.Certs))
	for _, lc := range rootLoad.Certs {
		rootNodes = append(rootNodes, chain.Node{
			Cert: lc.Cert, Source: lc.Source, SourceIndex: lc.SourceIndex, IsRoot: true,
		})
	}

	engine := verify.NewEngine(verify.Options{
		Time:          verifyTime,
		Hostname:      *hostname,
		Purposes:      purposes,
		AllowLegacyCN: *allowLegacyCN,
		Policy:        pol,
		Intermediates: interNodes,
		Roots:         rootNodes,
		Refs:          refs,
	})

	// Deterministic leaf ordering: sort by fingerprint so file/argument order
	// cannot jitter the output.
	sort.Slice(leafLoad.Certs, func(i, j int) bool {
		return report.Fingerprint(leafLoad.Certs[i].Cert) <
			report.Fingerprint(leafLoad.Certs[j].Cert)
	})

	doc := &report.Document{
		Tool:            "certverify",
		Version:         toolVersion,
		VerificationUTC: verifyTime.UTC().Format(time.RFC3339),
		Hostname:        *hostname,
		Purposes:        purposes,
		AllowLegacyCN:   *allowLegacyCN,
		Policy: report.PolicyView{
			MinRSABits:       pol.MinRSABits,
			MinECDSABits:     pol.MinECDSABits,
			RejectSHA1:       pol.RejectSHA1,
			RejectedSigAlgs:  policy.RejectedSigAlgs(pol),
			RejectedKeyTypes: policy.RejectedKeyTypes(),
		},
		Inputs: report.InputStats{
			LeafFiles:         leaves,
			IntermediateFiles: intermediates,
			RootFiles:         roots,
			LoadedCerts:       len(allLoaded),
			DuplicateCerts:    leafLoad.Duplicates + intermediateLoad.Duplicates + rootLoad.Duplicates,
			Warnings:          mergeWarnings(leafLoad.Warnings, intermediateLoad.Warnings, rootLoad.Warnings),
		},
	}

	doc.FinalDecision = report.StatusTrusted
	for _, lc := range leafLoad.Certs {
		res := engine.VerifyLeaf(lc.Cert)
		if res.Decision != report.StatusTrusted {
			doc.FinalDecision = report.StatusRejected
		}
		doc.Results = append(doc.Results, res)
	}

	out, err := renderReport(doc, *format)
	if err != nil {
		fmt.Fprintf(stderr, "error: failed to render report: %v\n", err)
		return exitInternal
	}
	if *output != "" {
		if err := os.WriteFile(*output, out, 0o644); err != nil {
			fmt.Fprintf(stderr, "error: cannot write %s: %v\n", *output, err)
			return exitFileError
		}
	} else {
		if _, err := stdout.Write(out); err != nil {
			return exitInternal
		}
	}

	if doc.FinalDecision == report.StatusTrusted {
		return exitOK
	}
	return exitVerificationFail
}

func loadPool(stderr *os.File, files []string, label string) (*certload.Result, int) {
	res, err := certload.LoadFiles(files)
	if err == nil {
		return res, exitOK
	}
	switch {
	case errors.Is(err, certload.ErrBadCert), errors.Is(err, certload.ErrMalformedPEM),
		errors.Is(err, certload.ErrNoCerts):
		fmt.Fprintf(stderr, "error: %s certificate input is unusable: %v\n", label, err)
		return res, exitCertInputError
	default:
		// Includes os read/permission failures.
		fmt.Fprintf(stderr, "error: cannot read %s file: %v\n", label, err)
		return res, exitFileError
	}
}

func parsePurposes(raw string) ([]string, error) {
	valid := map[string]bool{}
	for _, p := range verify.ValidPurposes() {
		valid[p] = true
	}
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		p := strings.TrimSpace(strings.ToLower(part))
		if p == "" {
			continue
		}
		if !valid[p] {
			return nil, fmt.Errorf("unknown purpose %q (valid: %s)", p,
				strings.Join(verify.ValidPurposes(), ","))
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("at least one purpose must be given")
	}
	sort.Strings(out)
	return out, nil
}

func parseTime(raw string) (time.Time, error) {
	if raw == "" {
		return time.Now().UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("time %q is neither RFC3339 nor YYYY-MM-DD", raw)
}

func renderReport(doc *report.Document, format string) ([]byte, error) {
	if format == "json" {
		return report.JSON(doc)
	}
	var b strings.Builder
	render.Text(&b, doc)
	return []byte(b.String()), nil
}

func mergeWarnings(groups ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range groups {
		for _, w := range g {
			if !seen[w] {
				seen[w] = true
				out = append(out, w)
			}
		}
	}
	sort.Strings(out)
	return out
}

func usage(fs *flag.FlagSet) {
	fmt.Fprintln(fs.Output(), "certverify — offline certificate chain verification")
	fmt.Fprintln(fs.Output(), "")
	fmt.Fprintln(fs.Output(), "Usage:")
	fmt.Fprintln(fs.Output(), "  certverify --root root.pem --intermediate inter.pem --leaf leaf.pem \\")
	fmt.Fprintln(fs.Output(), "             [--hostname host] [--purpose serverauth] [--time 2026-11-18] \\")
	fmt.Fprintln(fs.Output(), "             [--format text|json] [--output file] [--allow-legacy-cn] \\")
	fmt.Fprintln(fs.Output(), "             [--min-rsa-bits N] [--min-ecdsa-bits N] [--allow-sha1]")
	fmt.Fprintln(fs.Output(), "")
	fmt.Fprintln(fs.Output(), "Exit codes: 0 trusted; 2 usage error; 3 file error;")
	fmt.Fprintln(fs.Output(), "            4 malformed/missing certificate input; 5 verification rejected; 6 internal error")
	fs.PrintDefaults()
}
