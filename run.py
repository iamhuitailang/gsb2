#!/usr/bin/env python3
"""Entry point: ``python3 run.py`` (or ``python3 -m shot_shelf``)."""

import sys

from shot_shelf.server import main

if __name__ == "__main__":
    sys.exit(main())
