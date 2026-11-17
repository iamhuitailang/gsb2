import unittest

from dnscheck.cache import DnsCache
from dnscheck.clock import Clock
from dnscheck.model import Record


def rec(name="www.example.com", ttl=100, data="192.0.2.1"):
    return Record(name=name, rtype="A", rclass="IN", ttl=ttl, data=data)


class TestCache(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(1000)
        self.cache = DnsCache(self.clock, max_ttl=300, negative_ttl=60)
        self.key = ("www.example.com", "A")

    def test_store_and_get(self):
        self.assertTrue(self.cache.store_positive(self.key, [rec()], 100))
        entry = self.cache.get(self.key)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.kind, "positive")

    def test_ttl_clamped_to_local_cap(self):
        self.cache.store_positive(self.key, [rec(ttl=3600)], 3600)
        entry = self.cache.get(self.key)
        self.assertEqual(entry.expires_at, 1000 + 300)

    def test_expired_entry_does_not_hit(self):
        self.cache.store_positive(self.key, [rec()], 100)
        self.clock.advance(101)
        self.assertIsNone(self.cache.get(self.key))

    def test_entry_valid_at_boundary_minus_one(self):
        self.cache.store_positive(self.key, [rec()], 100)
        self.clock.advance(99)
        self.assertIsNotNone(self.cache.get(self.key))

    def test_cleanup_removes_only_expired(self):
        self.cache.store_positive(self.key, [rec()], 100)
        self.cache.store_positive(("other.example.com", "A"), [rec(name="other.example.com")], 500)
        self.clock.advance(150)
        removed = self.cache.cleanup()
        self.assertEqual(removed, 1)
        self.assertEqual(len(self.cache), 1)

    def test_negative_never_overrides_valid_positive(self):
        self.cache.store_positive(self.key, [rec()], 100)
        self.assertFalse(self.cache.store_negative(self.key))
        self.assertEqual(self.cache.get(self.key).kind, "positive")

    def test_negative_stored_and_expires(self):
        self.assertTrue(self.cache.store_negative(self.key))
        self.assertEqual(self.cache.get(self.key).kind, "nxdomain")
        self.clock.advance(61)
        self.assertIsNone(self.cache.get(self.key))

    def test_staler_positive_does_not_overwrite_fresher(self):
        self.cache.store_positive(self.key, [rec()], 300)
        # A late response with a shorter lifetime must not evict the fresh one.
        self.assertFalse(self.cache.store_positive(self.key, [rec(data="192.0.2.2")], 10))
        entry = self.cache.get(self.key)
        self.assertEqual(entry.records[0].data, "192.0.2.1")

    def test_longer_lived_positive_replaces(self):
        self.cache.store_positive(self.key, [rec()], 10)
        self.assertTrue(self.cache.store_positive(self.key, [rec(data="192.0.2.2")], 300))
        self.assertEqual(self.cache.get(self.key).records[0].data, "192.0.2.2")

    def test_expired_positive_can_be_replaced(self):
        self.cache.store_positive(self.key, [rec()], 100)
        self.clock.advance(150)
        self.assertTrue(self.cache.store_positive(self.key, [rec(data="192.0.2.2")], 50))
        self.assertEqual(self.cache.get(self.key).records[0].data, "192.0.2.2")

    def test_zero_ttl_not_cached(self):
        self.assertFalse(self.cache.store_positive(self.key, [rec(ttl=0)], 0))
        self.assertIsNone(self.cache.get(self.key))


if __name__ == "__main__":
    unittest.main()
