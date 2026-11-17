package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gsb2/certverify/internal/report"
	"gsb2/certverify/internal/testca"
)

type cliFixture struct {
	dir   string
	leaf  string
	inter string
	root  string
}

func setupFixture(t *testing.T) cliFixture {
	t.Helper()
	root := testca.Root("CLI Test Root")
	inter := root.Intermediate("CLI Test Intermediate", 1, false)
	leaf, _ := inter.Leaf("cli.example", []string{"cli.example", "www.cli.example"})

	dir := t.TempDir()
	f := cliFixture{dir: dir}
	f.leaf = write(t, dir, "leaf.pem", testca.PEMEncode(leaf))
	f.inter = write(t, dir, "inter.pem", testca.PEMEncode(inter.Cert))
	f.root = write(t, dir, "root.pem", testca.PEMEncode(root.Cert))
	return f
}

func write(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

// execute runs the CLI with in-memory output buffers and returns the exit
// code plus captured stdout/stderr. No real process or network is involved.
func execute(t *testing.T, args []string) (int, string, string) {
	t.Helper()
	out, err := os.CreateTemp("", "certverify-out-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(out.Name())
	errOut, err := os.CreateTemp("", "certverify-err-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(errOut.Name())

	code := run(args, out, errOut)

	outBytes, _ := os.ReadFile(out.Name())
	errBytes, _ := os.ReadFile(errOut.Name())
	return code, string(outBytes), string(errBytes)
}

func baseArgs(f cliFixture, extra ...string) []string {
	args := []string{
		"--root", f.root,
		"--intermediate", f.inter,
		"--leaf", f.leaf,
		"--hostname", "cli.example",
		"--purpose", "serverauth",
		"--time", "2026-06-01T12:00:00Z",
	}
	return append(args, extra...)
}

func TestExitTrusted(t *testing.T) {
	f := setupFixture(t)
	code, out, _ := execute(t, baseArgs(f))
	if code != exitOK {
		t.Fatalf("expected exit 0, got %d; output=%s", code, out)
	}
	if !strings.Contains(out, "FINAL DECISION: TRUSTED") {
		t.Fatalf("human output missing trusted decision: %s", out)
	}
}

func TestExitVerificationRejected(t *testing.T) {
	f := setupFixture(t)
	args := baseArgs(f, "--hostname", "wrong.host.example")
	code, out, _ := execute(t, args)
	if code != exitVerificationFail {
		t.Fatalf("expected exit %d, got %d", exitVerificationFail, code)
	}
	if !strings.Contains(out, "REJECTED") {
		t.Fatalf("rejected run should still print a full report, got: %s", out)
	}
}

func TestExitUntrustedRootIsNotCrash(t *testing.T) {
	f := setupFixture(t)
	otherRoot := testca.Root("CLI Other Root")
	otherPath := write(t, f.dir, "other-root.pem", testca.PEMEncode(otherRoot.Cert))
	args := []string{
		"--root", otherPath,
		"--intermediate", f.inter,
		"--leaf", f.leaf,
		"--time", "2026-06-01T12:00:00Z",
	}
	code, _, _ := execute(t, args)
	if code != exitVerificationFail {
		t.Fatalf("untrusted chain must be exit %d, got %d", exitVerificationFail, code)
	}
}

func TestExitUsageErrors(t *testing.T) {
	f := setupFixture(t)
	cases := [][]string{
		nil, // no arguments at all
		{"--leaf", f.leaf, "--root", f.root, "--format", "xml"},
		{"--leaf", f.leaf, "--root", f.root, "--purpose", "frobnicate"},
		{"--leaf", f.leaf, "--root", f.root, "--time", "not-a-time"},
		{"--leaf", f.leaf}, // missing root
	}
	for i, args := range cases {
		code, _, errText := execute(t, args)
		if code != exitUsage {
			t.Fatalf("case %d: expected usage exit %d, got %d (stderr=%s)",
				i, exitUsage, code, errText)
		}
	}
}

func TestExitFileError(t *testing.T) {
	f := setupFixture(t)
	missing := filepath.Join(f.dir, "does-not-exist.pem")
	code, _, errText := execute(t, baseArgs(f, "--root", missing))
	if code != exitFileError {
		t.Fatalf("expected file error exit %d, got %d", exitFileError, code)
	}
	if errText == "" {
		t.Fatal("file errors must be reported on stderr")
	}
}

func TestExitCertInputError(t *testing.T) {
	f := setupFixture(t)
	root := testca.Root("CLI Corrupt Root")
	corrupt := write(t, f.dir, "corrupt.pem", testca.CorruptPEM(root.Cert))
	code, _, errText := execute(t, baseArgs(f, "--root", corrupt))
	if code != exitCertInputError {
		t.Fatalf("expected cert input error exit %d, got %d", exitCertInputError, code)
	}
	if !strings.Contains(errText, "unusable") {
		t.Fatalf("expected a clear input error message, got: %s", errText)
	}
}

func TestJSONOutputIsValidAndStable(t *testing.T) {
	f := setupFixture(t)
	args := baseArgs(f, "--format", "json")
	code, first, _ := execute(t, args)
	if code != exitOK {
		t.Fatalf("trusted JSON run failed with %d: %s", code, first)
	}

	var doc report.Document
	if err := json.Unmarshal([]byte(first), &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, first)
	}
	if doc.FinalDecision != report.StatusTrusted {
		t.Fatalf("unexpected final decision %s", doc.FinalDecision)
	}
	if len(doc.Results) != 1 || len(doc.Results[0].SelectedChain) != 3 {
		t.Fatalf("expected one leaf with a 3-cert chain, got %+v", doc.Results)
	}
	if doc.Results[0].Checks[0].Cert == nil {
		t.Fatal("checks should reference the responsible certificate")
	}

	// A second run must produce byte-identical output.
	_, second, _ := execute(t, args)
	if !bytes.Equal([]byte(first), []byte(second)) {
		t.Fatal("JSON output is not stable across runs")
	}
}

func TestInputOrderDoesNotChangeResult(t *testing.T) {
	f := setupFixture(t)
	// Repeat the same cert files and reorder repeatable flags; the decision and
	// selected chain must be unaffected (warnings about duplicates may appear).
	argsA := baseArgs(f, "--format", "json", "--leaf", f.leaf)
	argsB := []string{
		"--leaf", f.leaf, "--leaf", f.leaf,
		"--root", f.root,
		"--intermediate", f.inter,
		"--hostname", "cli.example",
		"--purpose", "serverauth",
		"--time", "2026-06-01T12:00:00Z",
		"--format", "json",
	}
	codeA, outA, _ := execute(t, argsA)
	codeB, outB, _ := execute(t, argsB)
	if codeA != codeB {
		t.Fatalf("exit codes differ: %d vs %d", codeA, codeB)
	}
	var docA, docB report.Document
	if err := json.Unmarshal([]byte(outA), &docA); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(outB), &docB); err != nil {
		t.Fatal(err)
	}
	if docA.FinalDecision != docB.FinalDecision {
		t.Fatalf("decision changed with input order: %s vs %s",
			docA.FinalDecision, docB.FinalDecision)
	}
	if docB.Inputs.DuplicateCerts == 0 {
		t.Fatal("duplicate leaf should have been counted")
	}
	chainA := docA.Results[0].SelectedChain
	chainB := docB.Results[0].SelectedChain
	if len(chainA) != len(chainB) {
		t.Fatalf("chain length changed: %d vs %d", len(chainA), len(chainB))
	}
	for i := range chainA {
		if chainA[i].Cert.SHA256 != chainB[i].Cert.SHA256 {
			t.Fatalf("chain member %d differs across input orderings", i)
		}
	}
}

func TestOutputToFile(t *testing.T) {
	f := setupFixture(t)
	target := filepath.Join(f.dir, "report.json")
	code, _, _ := execute(t, baseArgs(f, "--format", "json", "--output", target))
	if code != exitOK {
		t.Fatalf("write run failed with %d", code)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("report file not written: %v", err)
	}
	if !json.Valid(data) {
		t.Fatal("written report is not valid JSON")
	}
}
