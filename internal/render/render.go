// Package render turns a report.Document into a stable, human-readable summary.
package render

import (
	"fmt"
	"io"
	"strings"

	"gsb2/certverify/internal/report"
)

// Text writes the human-readable form of doc to w. Layout and ordering are
// fixed so repeated runs with the same inputs produce identical text.
func Text(w io.Writer, doc *report.Document) {
	fmt.Fprintln(w, "================ Certificate verification report ================")
	fmt.Fprintf(w, "Verification time : %s\n", doc.VerificationUTC)
	if doc.Hostname != "" {
		fmt.Fprintf(w, "Target hostname   : %s (legacy CN fallback: %t)\n",
			doc.Hostname, doc.AllowLegacyCN)
	} else {
		fmt.Fprintln(w, "Target hostname   : <none>")
	}
	fmt.Fprintf(w, "Purposes          : %s\n", strings.Join(doc.Purposes, ", "))
	fmt.Fprintf(w, "Security policy   : RSA >= %d bits, ECDSA >= %d bits; reject SHA-1: %t\n",
		doc.Policy.MinRSABits, doc.Policy.MinECDSABits, doc.Policy.RejectSHA1)
	fmt.Fprintf(w, "Certificates loaded: %d (duplicates skipped: %d)\n",
		doc.Inputs.LoadedCerts, doc.Inputs.DuplicateCerts)
	for _, warning := range doc.Inputs.Warnings {
		fmt.Fprintf(w, "  warning: %s\n", warning)
	}

	for i, res := range doc.Results {
		fmt.Fprintln(w, strings.Repeat("-", 64))
		fmt.Fprintf(w, "Leaf #%d: %s\n", i+1, res.Leaf.Subject)
		fmt.Fprintf(w, "  serial=%s sha256=%s\n", res.Leaf.Serial, res.Leaf.SHA256)
		fmt.Fprintf(w, "  source=%s#%d\n", res.Leaf.Source, res.Leaf.SourceIndex)
		fmt.Fprintf(w, "  DECISION: %s\n", res.Decision)
		fmt.Fprintf(w, "  %s\n", res.Summary)

		if len(res.SelectedChain) > 0 {
			fmt.Fprintln(w, "  Selected chain:")
			for _, link := range res.SelectedChain {
				fmt.Fprintf(w, "    [%d] %-12s %s\n",
					link.Position, link.Role, link.Cert.Subject)
			}
		} else {
			fmt.Fprintln(w, "  Selected chain: <none>")
		}

		fmt.Fprintln(w, "  Checks:")
		for _, c := range res.Checks {
			fmt.Fprintf(w, "    [%s] %s\n", padStatus(string(c.Status)), c.Title)
			fmt.Fprintf(w, "          %s\n", c.Detail)
			if c.Cert != nil {
				fmt.Fprintf(w, "          certificate: %s (%s#%d)\n",
					c.Cert.Subject, c.Cert.Source, c.Cert.SourceIndex)
			}
			for _, ev := range c.Evidence {
				fmt.Fprintf(w, "          evidence: %s\n", ev)
			}
		}

		if len(res.ChainAttempts) > 0 {
			fmt.Fprintln(w, "  Failed chain attempts:")
			for _, a := range res.ChainAttempts {
				fmt.Fprintf(w, "    path %s\n", strings.Join(a.Subjects, " -> "))
				if a.Failure != "" {
					fmt.Fprintf(w, "      reason: %s\n", a.Failure)
				}
			}
		}
	}

	fmt.Fprintln(w, strings.Repeat("=", 64))
	fmt.Fprintf(w, "FINAL DECISION: %s\n", doc.FinalDecision)
}

func padStatus(s string) string {
	return s + strings.Repeat(" ", 4-len(s))
}
