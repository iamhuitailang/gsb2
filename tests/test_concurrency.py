import threading
import unittest

from dnscheck.cache import DnsCache
from dnscheck.clock import Clock
from dnscheck.model import Question, Record, Response
from dnscheck.resolver import Resolver


def arec(name="www.example.com", data="192.0.2.1", ttl=100):
    return Record(name=name, rtype="A", rclass="IN", ttl=ttl, data=data)


def query(name="www.example.com", qid=1):
    return Question(name=name, qtype="A", qid=qid)


def ok(rid, name="www.example.com", answers=()):
    return Response(
        id=rid, rcode="NOERROR", question=Question(name=name, qtype="A"), answers=tuple(answers)
    )


class TestConcurrentCacheAccess(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(0)
        self.cache = DnsCache(self.clock, max_ttl=300, negative_ttl=60)
        self.key = ("www.example.com", "A")

    def _run_threads(self, fns):
        barrier = threading.Barrier(len(fns))

        def wrap(fn):
            def inner():
                barrier.wait()
                fn()
            return inner

        threads = [threading.Thread(target=wrap(f)) for f in fns]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def test_concurrent_stores_keep_longest_lived(self):
        # Many threads store the same key with different TTLs; whatever the
        # completion order, the longest-lived entry must survive.
        ttls = [10, 50, 300, 100, 30, 200]
        fns = [
            (lambda ttl=ttl: self.cache.store_positive(self.key, [arec(data=f"192.0.2.{ttl}")], ttl))
            for ttl in ttls
        ]
        self._run_threads(fns)
        entry = self.cache.get(self.key)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.expires_at, 300)

    def test_concurrent_negative_never_dislodges_positive(self):
        self.cache.store_positive(self.key, [arec()], 300)
        fns = [lambda: self.cache.store_negative(self.key) for _ in range(8)]
        self._run_threads(fns)
        self.assertEqual(self.cache.get(self.key).kind, "positive")

    def test_concurrent_reads_during_expiry_never_see_phantoms(self):
        self.cache.store_positive(self.key, [arec()], 50)
        self.clock.advance(60)  # now expired
        results = []
        lock = threading.Lock()

        def reader():
            entry = self.cache.get(self.key)
            with lock:
                results.append(entry)

        self._run_threads([reader for _ in range(16)])
        self.assertTrue(all(r is None for r in results))
        self.assertEqual(len(self.cache), 0)

    def test_resolver_race_rejected_response_never_cached(self):
        resolver = Resolver(self.cache)
        good = ok(1, answers=[arec(ttl=300)])
        bad = Response(
            id=999,  # mismatched transaction id -> rejected
            rcode="NOERROR",
            question=Question(name="www.example.com", qtype="A"),
            answers=(arec(data="203.0.113.9", ttl=300),),
        )
        outcomes = []
        lock = threading.Lock()

        def run(qid, upstream):
            r = resolver.resolve(query(qid=qid), upstream)
            with lock:
                outcomes.append(r.status)

        fns = [lambda: run(1, good), lambda: run(2, bad)]
        self._run_threads(fns)
        self.assertIn("ACCEPT", outcomes)
        self.assertIn("REJECT", outcomes)
        entry = self.cache.get(self.key)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.records[0].data, "192.0.2.1")

    def test_resolver_race_servfail_never_overwrites_positive(self):
        resolver = Resolver(self.cache)
        self.cache.store_positive(self.key, [arec()], 300)
        servfail = Response(
            id=2, rcode="SERVFAIL", question=Question(name="www.example.com", qtype="A")
        )
        fns = [lambda: resolver.resolve(query(qid=2), servfail) for _ in range(8)]
        self._run_threads(fns)
        entry = self.cache.get(self.key)
        self.assertEqual(entry.kind, "positive")
        self.assertEqual(entry.records[0].data, "192.0.2.1")

    def test_queries_for_different_names_do_not_interfere(self):
        resolver = Resolver(self.cache)
        fns = [
            (lambda i=i: resolver.resolve(
                query(name=f"host{i}.example.com", qid=i),
                ok(i, name=f"host{i}.example.com",
                   answers=[arec(name=f"host{i}.example.com", data=f"192.0.2.{i}")])))
            for i in range(10)
        ]
        self._run_threads(fns)
        for i in range(10):
            entry = self.cache.get((f"host{i}.example.com", "A"))
            self.assertIsNotNone(entry)
            self.assertEqual(entry.records[0].data, f"192.0.2.{i}")


if __name__ == "__main__":
    unittest.main()
