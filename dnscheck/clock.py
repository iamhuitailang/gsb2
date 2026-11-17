"""Controllable clock so cache expiry is testable without real waiting."""
from __future__ import annotations

import threading


class Clock:
    def __init__(self, start: float = 0.0):
        self._t = float(start)
        self._lock = threading.Lock()

    def now(self) -> float:
        with self._lock:
            return self._t

    def advance(self, seconds: float) -> float:
        if seconds < 0:
            raise ValueError("cannot move the clock backwards")
        with self._lock:
            self._t += seconds
            return self._t
