"""Local drum-sample replacement workbench (procedural audio, numpy only)."""

from .synthesis import (
    SAMPLE_RATE, Event, build_practice_scene, build_sample_library,
)
from .detection import DetectionParams, detect_hits
from .replacement import render_replacement, verify, RenderResult, VerificationReport

__all__ = [
    "SAMPLE_RATE", "Event", "build_practice_scene", "build_sample_library",
    "DetectionParams", "detect_hits",
    "render_replacement", "verify", "RenderResult", "VerificationReport",
]
