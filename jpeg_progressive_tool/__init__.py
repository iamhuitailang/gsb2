"""Progressive JPEG inspection tool.

Parse JPEG structure, simulate reading a file up to arbitrary byte
offsets, preview what decodes at each scan boundary, compare early
previews against the full image, and export scan manifests plus
decodable-stage PNGs.
"""

__version__ = "0.1.0"
