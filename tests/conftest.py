import sys
from pathlib import Path

# make the repo root importable so `import drumreplace` works from tests/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
