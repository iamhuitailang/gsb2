// Package verify orchestrates full offline certificate verification: it
// builds paths against only the caller-supplied trust roots, runs structural,
// temporal, algorithmic, hostname and key-usage checks, and records every
// individual check so that a rejection names the certificate and the rule.
package verify

import (
	"crypto/x509"
	"encoding/asn1"
	"fmt"
	"sort"
	"time"

	"gsb2/certverify/internal/chain"
	"gsb2/certverify/internal/hostname"
	"gsb2/certverify/internal/policy"
	"gsb2/certverify/internal/report"
	"gsb2/certverify/internal/sigverify"
)

// Options controls one verification run.
type Options struct {
	Time          time.Time
	Hostname      string
	Purposes      []string
	AllowLegacyCN bool
	Policy        policy.Policy

	Leaf          *x509.Certificate
	Intermediates []chain.Node
	Roots         []chain.Node
	// Refs maps every parsed certificate to its stable report reference.
	Refs map[*x509.Certificate]report.CertRef
}

// PurposeOIDs maps a caller-supplied purpose to the EKU OID that expresses it.
var PurposeOIDs = map[string]asn1.ObjectIdentifier{
	"serverauth":  oidExtKeyUsageServerAuth,
	"clientauth":  oidExtKeyUsageClientAuth,
	"codesigning": oidExtKeyUsageCodeSigning,
	"email":       oidExtKeyUsageEmailProtection,
}

// ValidPurposes lists the accepted --purpose values including the wildcard.
func ValidPurposes() []string {
	return []string{"serverauth", "clientauth", "codesigning", "email", "all"}
}

var (
	oidExtKeyUsageServerAuth      = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 1}
	oidExtKeyUsageClientAuth      = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 2}
	oidExtKeyUsageCodeSigning     = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 3}
	oidExtKeyUsageEmailProtection = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 4}
	oidExtKeyUsageAny             = asn1.ObjectIdentifier{2, 5, 29, 37, 0}
)

// Engine runs verification with fixed policy and pools.
type Engine struct {
	time          time.Time
	hostname      string
	purposes      []string
	allowLegacyCN bool
	pol           policy.Policy
	builder       *chain.Builder
	refs          map[*x509.Certificate]report.CertRef
}

// NewEngine constructs an engine from the run options.
func NewEngine(opts Options) *Engine {
	return &Engine{
		time:          opts.Time,
		hostname:      opts.Hostname,
		purposes:      opts.Purposes,
		allowLegacyCN: opts.AllowLegacyCN,
		pol:           opts.Policy,
		builder:       chain.NewBuilder(opts.Intermediates, opts.Roots),
		refs:          opts.Refs,
	}
}

// VerifyLeaf produces the full per-leaf result. The checklist ordering is
// fixed, so identical inputs always produce identical output.
func (e *Engine) VerifyLeaf(leaf *x509.Certificate) report.LeafResult {
	res := report.LeafResult{
		Leaf:     e.ref(leaf),
		Decision: report.StatusRejected,
	}

	chains, attempts := e.builder.Build(leaf)
	for _, a := range attempts {
		res.ChainAttempts = append(res.ChainAttempts, report.ChainAttempt{
			Subjects: a.Subjects,
			Failure:  a.Failure,
		})
	}

	selected := selectChain(chains)
	res.Checks = append(res.Checks, e.chainBuildCheck(leaf, chains, attempts))

	if selected != nil {
		res.SelectedChain = e.describeChain(selected.Certs)
		res.Checks = append(res.Checks, e.linkChecks(selected.Certs)...)
		res.Checks = append(res.Checks, e.pathLenCheck(selected.Certs))
		res.Checks = append(res.Checks, e.validityChecks(selected.Certs)...)
		res.Checks = append(res.Checks, e.policyChecks(selected.Certs)...)
		res.Checks = append(res.Checks, e.intermediateEKUChecks(selected.Certs)...)
	} else {
		// Without a chain we can still evaluate the leaf on its own merits.
		res.Checks = append(res.Checks, e.validityChecks([]*x509.Certificate{leaf})...)
		res.Checks = append(res.Checks, e.policyChecks([]*x509.Certificate{leaf})...)
	}

	res.Checks = append(res.Checks,
		e.hostnameCheck(leaf),
		e.keyUsageCheck(leaf),
		e.extKeyUsageCheck(leaf),
	)

	if selected != nil && !hasFail(res.Checks) {
		res.Decision = report.StatusTrusted
		res.Summary = fmt.Sprintf(
			"TRUSTED: a valid chain of %d certificate(s) anchors at a supplied trust root and all checks passed",
			len(selected.Certs))
	} else {
		res.Summary = "REJECTED: " + e.rejectSummary(res.Checks, selected == nil)
	}
	return res
}

func (e *Engine) ref(c *x509.Certificate) report.CertRef {
	if r, ok := e.refs[c]; ok {
		return r
	}
	return report.NewCertRef(c, "<memory>", 0)
}

// selectChain deterministically picks the shortest valid chain, breaking ties
// by certificate fingerprints so input ordering never changes the decision.
func selectChain(chains []chain.BuiltChain) *chain.BuiltChain {
	if len(chains) == 0 {
		return nil
	}
	best := 0
	for i := 1; i < len(chains); i++ {
		if shorterOrLexSmaller(chains[i].Certs, chains[best].Certs) {
			best = i
		}
	}
	return &chains[best]
}

func shorterOrLexSmaller(a, b []*x509.Certificate) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	for i := range a {
		fa, fb := report.Fingerprint(a[i]), report.Fingerprint(b[i])
		if fa != fb {
			return fa < fb
		}
	}
	return false
}

func (e *Engine) describeChain(certs []*x509.Certificate) []report.ChainCert {
	out := make([]report.ChainCert, 0, len(certs))
	for i, c := range certs {
		role := "intermediate"
		switch {
		case i == 0:
			role = "leaf"
		case i == len(certs)-1:
			role = "root"
		}
		out = append(out, report.ChainCert{
			Position: i,
			Role:     role,
			Cert:     e.ref(c),
		})
	}
	return out
}

func (e *Engine) chainBuildCheck(leaf *x509.Certificate, chains []chain.BuiltChain, attempts []chain.Attempt) report.Check {
	if len(chains) > 0 {
		return report.Check{
			ID:     "chain.build",
			Title:  "Certification path construction",
			Status: report.CheckPass,
			Detail: fmt.Sprintf("%d complete path(s) built to a supplied trust root; shortest path selected",
				len(chains)),
			Cert: ptrRef(e.ref(leaf)),
		}
	}
	return report.Check{
		ID:     "chain.build",
		Title:  "Certification path construction",
		Status: report.CheckFail,
		Detail: fmt.Sprintf("no certification path from this leaf to any supplied trust root (%d failed attempt(s) recorded below)",
			len(attempts)),
		Cert: ptrRef(e.ref(leaf)),
	}
}

// linkChecks emits one explicit signature and one CA-constraint check per
// parent in the selected chain, making the "not just the leaf" requirement
// visible in the output.
func (e *Engine) linkChecks(certs []*x509.Certificate) []report.Check {
	var checks []report.Check
	for i := 1; i < len(certs); i++ {
		child, parent := certs[i-1], certs[i]

		sig := report.Check{
			ID:    "chain.signature",
			Title: fmt.Sprintf("Issuer signature on %q", child.Subject.String()),
			Cert:  ptrRef(e.ref(parent)),
		}
		// sigverify.Link checks only signature mathematics; algorithm strength
		// is evaluated separately by the algorithm-strength policy check.
		if err := sigverify.Link(child, parent); err != nil {
			sig.Status = report.CheckFail
			sig.Detail = fmt.Sprintf("signature by issuer %q does not verify: %v",
				parent.Subject.String(), err)
		} else {
			sig.Status = report.CheckPass
			sig.Detail = fmt.Sprintf("signature by issuer %q (%s) verifies against the child's public key",
				parent.Subject.String(), parent.SignatureAlgorithm)
		}
		checks = append(checks, sig)

		ca := report.Check{
			ID:    "chain.ca",
			Title: fmt.Sprintf("CA basic constraints on %q", parent.Subject.String()),
			Cert:  ptrRef(e.ref(parent)),
		}
		switch {
		case !parent.BasicConstraintsValid:
			ca.Status = report.CheckFail
			ca.Detail = "basic constraints extension is missing or invalid"
		case !parent.IsCA:
			ca.Status = report.CheckFail
			ca.Detail = "certificate is asserted as issuer but cA is FALSE"
		case parent.KeyUsage != 0 && parent.KeyUsage&x509.KeyUsageCertSign == 0:
			ca.Status = report.CheckFail
			ca.Detail = "CA certificate is not permitted to sign certificates (keyCertSign absent)"
		default:
			ca.Status = report.CheckPass
			ca.Detail = "cA=TRUE with valid basic constraints and keyCertSign permitted"
		}
		checks = append(checks, ca)
	}
	return checks
}

func (e *Engine) pathLenCheck(certs []*x509.Certificate) report.Check {
	if viol, ok := chain.CheckPathLength(certs); !ok {
		return report.Check{
			ID:     "chain.pathlen",
			Title:  "Path length constraints (basicConstraints pathLen)",
			Status: report.CheckFail,
			Detail: fmt.Sprintf("%s: %s", viol.Cert.Subject.String(), viol.Reason),
			Cert:   ptrRef(e.ref(viol.Cert)),
		}
	}
	var constrained []string
	for i := 0; i < len(certs)-1; i++ {
		c := certs[i]
		if c.IsCA && (c.MaxPathLen > 0 || c.MaxPathLenZero) {
			limit := c.MaxPathLen
			if c.MaxPathLenZero {
				limit = 0
			}
			constrained = append(constrained, fmt.Sprintf("%s<=%d", c.Subject.String(), limit))
		}
	}
	detail := "all pathLenConstraint values are satisfied"
	if len(constrained) > 0 {
		detail = "all pathLenConstraint values are satisfied: " + joinSort(constrained)
	}
	return report.Check{
		ID:     "chain.pathlen",
		Title:  "Path length constraints (basicConstraints pathLen)",
		Status: report.CheckPass,
		Detail: detail,
	}
}

func (e *Engine) validityChecks(certs []*x509.Certificate) []report.Check {
	checks := make([]report.Check, 0, len(certs))
	for _, c := range certs {
		chk := report.Check{
			ID:    "validity",
			Title: fmt.Sprintf("Validity period of %q", c.Subject.String()),
			Cert:  ptrRef(e.ref(c)),
		}
		switch {
		case e.time.Before(c.NotBefore):
			chk.Status = report.CheckFail
			chk.Detail = fmt.Sprintf("certificate is not yet valid at %s (notBefore %s)",
				e.time.UTC().Format(time.RFC3339), c.NotBefore.UTC().Format(time.RFC3339))
		case e.time.After(c.NotAfter):
			chk.Status = report.CheckFail
			chk.Detail = fmt.Sprintf("certificate expired at %s; verification time %s",
				c.NotAfter.UTC().Format(time.RFC3339),
				e.time.UTC().Format(time.RFC3339))
		default:
			chk.Status = report.CheckPass
			chk.Detail = fmt.Sprintf("verification time %s is within [%s, %s]",
				e.time.UTC().Format(time.RFC3339),
				c.NotBefore.UTC().Format(time.RFC3339),
				c.NotAfter.UTC().Format(time.RFC3339))
		}
		checks = append(checks, chk)
	}
	return checks
}

func (e *Engine) policyChecks(certs []*x509.Certificate) []report.Check {
	checks := make([]report.Check, 0, len(certs))
	for _, c := range certs {
		violations := policy.Evaluate(e.pol, c)
		chk := report.Check{
			ID:    "algorithm-strength",
			Title: fmt.Sprintf("Algorithm and key strength boundary for %q", c.Subject.String()),
			Cert:  ptrRef(e.ref(c)),
		}
		if len(violations) == 0 {
			chk.Status = report.CheckPass
			chk.Detail = fmt.Sprintf("signature %s and %s are within the security boundary",
				c.SignatureAlgorithm, keyType(c))
		} else {
			chk.Status = report.CheckFail
			reasons := make([]string, 0, len(violations))
			for _, v := range violations {
				reasons = append(reasons, v.Reason)
			}
			chk.Detail = joinSort(reasons)
		}
		checks = append(checks, chk)
	}
	return checks
}

// intermediateEKUChecks enforces EKU nesting: an intermediate that asserts an
// EKU extension must permit every purpose requested for the leaf.
func (e *Engine) intermediateEKUChecks(certs []*x509.Certificate) []report.Check {
	required := e.requiredEKUs()
	if len(required) == 0 {
		return nil
	}
	var checks []report.Check
	for i := 1; i < len(certs)-1; i++ {
		c := certs[i]
		chk := report.Check{
			ID:    "chain.eku",
			Title: fmt.Sprintf("Extended key usage nesting on intermediate %q", c.Subject.String()),
			Cert:  ptrRef(e.ref(c)),
		}
		if len(c.ExtKeyUsage) == 0 && len(c.UnknownExtKeyUsage) == 0 {
			chk.Status = report.CheckPass
			chk.Detail = "no EKU extension on intermediate; it does not restrict leaf purposes"
			checks = append(checks, chk)
			continue
		}
		missing := ekuMissing(c, required)
		if containsOID(c.UnknownExtKeyUsage, oidExtKeyUsageAny) ||
			containsEKU(c.ExtKeyUsage, x509.ExtKeyUsageAny) {
			chk.Status = report.CheckPass
			chk.Detail = "intermediate includes anyExtendedKeyUsage"
		} else if len(missing) == 0 {
			chk.Status = report.CheckPass
			chk.Detail = "intermediate EKU permits every requested leaf purpose"
		} else {
			chk.Status = report.CheckFail
			chk.Detail = "intermediate EKU does not permit requested purpose(s): " + joinSort(missing)
		}
		checks = append(checks, chk)
	}
	return checks
}

func (e *Engine) hostnameCheck(leaf *x509.Certificate) report.Check {
	chk := report.Check{
		ID:    "hostname",
		Title: "Target hostname verification",
		Cert:  ptrRef(e.ref(leaf)),
	}
	if e.hostname == "" {
		chk.Status = report.CheckInfo
		chk.Detail = "no --hostname supplied; hostname verification skipped"
		return chk
	}
	r := hostname.Verify(leaf, e.hostname, e.allowLegacyCN)
	chk.Evidence = r.Evidence
	if r.Matched {
		chk.Status = report.CheckPass
	} else {
		chk.Status = report.CheckFail
	}
	chk.Detail = fmt.Sprintf("target %q: %s", e.hostname, r.Detail)
	return chk
}

func (e *Engine) keyUsageCheck(leaf *x509.Certificate) report.Check {
	chk := report.Check{
		ID:    "key-usage",
		Title: "Leaf key usage compatibility",
		Cert:  ptrRef(e.ref(leaf)),
	}
	if hasPurpose(e.purposes, "all") {
		chk.Status = report.CheckInfo
		chk.Detail = "purpose 'all' requested; key-usage enforcement skipped"
		return chk
	}
	if leaf.KeyUsage == 0 {
		chk.Status = report.CheckPass
		chk.Detail = "no key usage extension present; RFC 5280 permits any usage"
		return chk
	}
	needed := neededKeyUsageBits(e.purposes)
	if leaf.KeyUsage&needed != 0 {
		chk.Status = report.CheckPass
		chk.Detail = fmt.Sprintf("key usage 0x%x includes a bit required by the requested purpose(s)",
			uint(leaf.KeyUsage))
	} else {
		chk.Status = report.CheckFail
		chk.Detail = fmt.Sprintf("key usage 0x%x contains none of the bits required for %v",
			uint(leaf.KeyUsage), e.purposes)
	}
	return chk
}

func (e *Engine) extKeyUsageCheck(leaf *x509.Certificate) report.Check {
	chk := report.Check{
		ID:    "extended-key-usage",
		Title: "Leaf extended key usage (EKU)",
		Cert:  ptrRef(e.ref(leaf)),
	}
	if hasPurpose(e.purposes, "all") {
		chk.Status = report.CheckInfo
		chk.Detail = "purpose 'all' requested; EKU enforcement skipped"
		return chk
	}
	required := e.requiredEKUs()
	if len(leaf.ExtKeyUsage) == 0 && len(leaf.UnknownExtKeyUsage) == 0 {
		chk.Status = report.CheckPass
		chk.Detail = "no EKU extension present; RFC 5280 treats the certificate as valid for any purpose"
		return chk
	}
	if containsEKU(leaf.ExtKeyUsage, x509.ExtKeyUsageAny) ||
		containsOID(leaf.UnknownExtKeyUsage, oidExtKeyUsageAny) {
		chk.Status = report.CheckPass
		chk.Detail = "leaf includes anyExtendedKeyUsage"
		return chk
	}
	missing := ekuMissing(leaf, required)
	if len(missing) == 0 {
		chk.Status = report.CheckPass
		chk.Detail = "leaf EKU includes every requested purpose"
		return chk
	}
	chk.Status = report.CheckFail
	chk.Detail = "leaf EKU is missing requested purpose(s): " + joinSort(missing)
	return chk
}

func (e *Engine) requiredEKUs() []asn1.ObjectIdentifier {
	var out []asn1.ObjectIdentifier
	seen := map[string]bool{}
	for _, p := range e.purposes {
		oid, ok := PurposeOIDs[p]
		if !ok {
			continue
		}
		key := oid.String()
		if !seen[key] {
			seen[key] = true
			out = append(out, oid)
		}
	}
	return out
}

func (e *Engine) rejectSummary(checks []report.Check, noChain bool) string {
	var fails []string
	for _, c := range checks {
		if c.Status == report.CheckFail {
			fails = append(fails, c.ID)
		}
	}
	sort.Strings(fails)
	if noChain {
		return "certificate could not be chained to any supplied trust root; failing checks: " +
			joinSort(unique(fails))
	}
	return "the following check(s) failed: " + joinSort(unique(fails))
}

func hasFail(checks []report.Check) bool {
	for _, c := range checks {
		if c.Status == report.CheckFail {
			return true
		}
	}
	return false
}

func neededKeyUsageBits(purposes []string) x509.KeyUsage {
	var bits x509.KeyUsage
	for _, p := range purposes {
		switch p {
		case "serverauth", "email":
			bits |= x509.KeyUsageDigitalSignature |
				x509.KeyUsageKeyEncipherment | x509.KeyUsageKeyAgreement
		case "clientauth":
			bits |= x509.KeyUsageDigitalSignature | x509.KeyUsageKeyAgreement
		case "codesigning":
			bits |= x509.KeyUsageDigitalSignature
		}
	}
	return bits
}

func ekuMissing(cert *x509.Certificate, required []asn1.ObjectIdentifier) []string {
	var missing []string
	for _, oid := range required {
		if !certHasEKU(cert, oid) {
			missing = append(missing, oid.String())
		}
	}
	return missing
}

func certHasEKU(cert *x509.Certificate, want asn1.ObjectIdentifier) bool {
	for _, u := range cert.UnknownExtKeyUsage {
		if u.Equal(want) {
			return true
		}
	}
	// Standard usages are parsed into ExtKeyUsage; map the common OIDs back.
	switch want.String() {
	case oidExtKeyUsageServerAuth.String():
		return containsEKU(cert.ExtKeyUsage, x509.ExtKeyUsageServerAuth)
	case oidExtKeyUsageClientAuth.String():
		return containsEKU(cert.ExtKeyUsage, x509.ExtKeyUsageClientAuth)
	case oidExtKeyUsageCodeSigning.String():
		return containsEKU(cert.ExtKeyUsage, x509.ExtKeyUsageCodeSigning)
	case oidExtKeyUsageEmailProtection.String():
		return containsEKU(cert.ExtKeyUsage, x509.ExtKeyUsageEmailProtection)
	}
	return false
}

func containsEKU(list []x509.ExtKeyUsage, want x509.ExtKeyUsage) bool {
	for _, u := range list {
		if u == want {
			return true
		}
	}
	return false
}

func containsOID(list []asn1.ObjectIdentifier, want asn1.ObjectIdentifier) bool {
	for _, o := range list {
		if o.Equal(want) {
			return true
		}
	}
	return false
}

func hasPurpose(purposes []string, want string) bool {
	for _, p := range purposes {
		if p == want {
			return true
		}
	}
	return false
}

func keyType(c *x509.Certificate) string {
	return fmt.Sprintf("%T", c.PublicKey)
}

func ptrRef(r report.CertRef) *report.CertRef { return &r }

func joinSort(items []string) string {
	sort.Strings(items)
	out := ""
	for i, s := range items {
		if i > 0 {
			out += "; "
		}
		out += s
	}
	return out
}

func unique(items []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range items {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
