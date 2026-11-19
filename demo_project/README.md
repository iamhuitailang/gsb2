# Demo project (synthetic credentials only)

Everything in this directory is **fake, generated-for-demo material**. None of
the values below work against any service. The strings are intentionally shaped
like real credential formats so the scanner rules can be exercised end-to-end.

Layout:

| Path | Purpose |
| --- | --- |
| `src/config.py` | AWS key id + secret, plus a generic API key that overlaps with a more specific rule |
| `src/db.py` | PostgreSQL connection string with an inline password |
| `src/http_client.js` | `Authorization: Bearer …` header |
| `secrets/demo-key.pem` | PEM private key block (synthetic body) |
| `moved/config.py` | Copy of `src/config.py` used to prove identity survives file moves |
| `notes/README.txt` | Plain text, no findings, used to shift line numbers |
| `assets/logo.bin` | Binary file, must be reported as skipped |
| `huge/large.log` | Oversized file, must be reported as skipped |
| `links/outside-link` | Symbolic link pointing outside the project root, must never be read |

`links/` and the oversized file are created by `scripts/make_demo.py` because a
symlink target and a large file cannot be represented cleanly in git.

The demo is also used by `tests/test_integration.py`.
