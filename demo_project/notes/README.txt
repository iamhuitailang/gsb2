# Fillers

Notes used only to shift line numbers between scans. Nothing here matches a
credential rule.

1. Lorem ipsum-ish filler paragraph.
2. Another filler paragraph.
3. A third filler paragraph.

`src/config.py` and `moved/config.py` contain the same synthetic AWS key pair,
so the same credential is reported at two paths. Moving a file between scans does
not change the credential's identity, and the baseline comparison must not treat
the move as a new exposure.
