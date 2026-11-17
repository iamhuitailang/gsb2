"""Thread-safe DNS cache with TTL clamping, negative caching and a
controllable clock.

Overwrite rules (these are what make concurrent access safe):

* A rejected response never reaches the cache (enforced by the resolver).
* A negative entry (NXDOMAIN) never replaces a still-valid positive entry.
* A positive entry replaces a still-valid positive entry only if it
  expires later; this stops a slow, staler response from overwriting a
  fresher one just because it finished last.
* Expired entries are invisible to readers and may always be replaced.
"""
from __future__ import annotations

import threading


class CacheEntry:
    __slots__ = ("kind", "records", "expires_at")

    def __init__(self, kind, records, expires_at):
        self.kind = kind  # "positive" | "nxdomain"
        self.records = records
        self.expires_at = expires_at

    def __repr__(self):
        return f"CacheEntry({self.kind}, {len(self.records)} records, expires_at={self.expires_at})"


class DnsCache:
    def __init__(self, clock, max_ttl: int = 300, negative_ttl: int = 60):
        if max_ttl <= 0 or negative_ttl <= 0:
            raise ValueError("TTL limits must be positive")
        self._clock = clock
        self._max_ttl = max_ttl
        self._negative_ttl = negative_ttl
        self._entries = {}
        self._lock = threading.Lock()

    @property
    def max_ttl(self):
        return self._max_ttl

    def clamp_ttl(self, ttl: int) -> int:
        """Upstream TTLs may not exceed the local cap."""
        return min(ttl, self._max_ttl)

    def get(self, key):
        """Return the live entry for key, or None. Expired entries are
        treated as absent and removed lazily."""
        now = self._clock.now()
        with self._lock:
            e = self._entries.get(key)
            if e is None:
                return None
            if e.expires_at <= now:
                del self._entries[key]
                return None
            return e

    def store_positive(self, key, records, ttl) -> bool:
        """Cache a positive record set. Returns True if stored."""
        clamped = self.clamp_ttl(ttl)
        if clamped <= 0:
            return False
        now = self._clock.now()
        expires = now + clamped
        with self._lock:
            existing = self._entries.get(key)
            if (
                existing is not None
                and existing.kind == "positive"
                and existing.expires_at > now
                and existing.expires_at >= expires
            ):
                # A still-valid entry that lives at least as long wins;
                # a late, shorter-lived response must not evict it.
                return False
            self._entries[key] = CacheEntry("positive", tuple(records), expires)
            return True

    def store_negative(self, key) -> bool:
        """Cache an NXDOMAIN. Never overrides a still-valid positive."""
        now = self._clock.now()
        with self._lock:
            existing = self._entries.get(key)
            if (
                existing is not None
                and existing.kind == "positive"
                and existing.expires_at > now
            ):
                return False
            self._entries[key] = CacheEntry("nxdomain", (), now + self._negative_ttl)
            return True

    def cleanup(self) -> int:
        """Drop all expired entries; returns how many were removed."""
        now = self._clock.now()
        with self._lock:
            doomed = [k for k, e in self._entries.items() if e.expires_at <= now]
            for k in doomed:
                del self._entries[k]
            return len(doomed)

    def __len__(self):
        with self._lock:
            return len(self._entries)
