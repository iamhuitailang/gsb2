"""``python3 -m shot_shelf`` entry point."""

import sys

from .server import main

if __name__ == "__main__":
    sys.exit(main())
