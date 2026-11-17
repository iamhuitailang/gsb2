import unittest

from dnscheck.cache import DnsCache
from dnscheck.clock import Clock
from dnscheck.model import Question, Record, Response
from dnscheck.resolver import Resolver, resolve_chain


def cname(name, target, ttl=100):
    return Record(name=name, rtype="CNAME", rclass="IN", ttl=ttl, data=target)


def arec(name, data="192.0.2.1", ttl=100):
    return Record(name=name, rtype="A", rclass="IN", ttl=ttl, data=data)


def query(name, qid=1):
    return Question(name=name, qtype="A", qid=qid)


def response(rid, qname, answers):
    return Response(
        id=rid,
        rcode="NOERROR",
        question=Question(name=qname, qtype="A"),
        answers=tuple(answers),
    )


class TestCnameChains(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(0)
        self.cache = DnsCache(self.clock, max_ttl=300, negative_ttl=60)
        self.resolver = Resolver(self.cache, max_cname_depth=4)

    def test_simple_chain_accepted(self):
        r = self.resolver.resolve(
            query("www.example.com"),
            response(1, "www.example.com",
                     [cname("www.example.com", "cdn.example.net"),
                      arec("cdn.example.net", "192.0.2.9")]),
        )
        self.assertEqual(r.status, "ACCEPT")
        self.assertEqual([a.rtype for a in r.answers], ["CNAME", "A"])

    def test_chain_completed_from_cache(self):
        # First query caches the CNAME target's A record.
        self.resolver.resolve(
            query("cdn.example.net"),
            response(1, "cdn.example.net", [arec("cdn.example.net", "192.0.2.9")]),
        )
        # Second response only carries the CNAME hop; the cache completes it.
        r = self.resolver.resolve(
            query("www.example.com", qid=2),
            response(2, "www.example.com",
                     [cname("www.example.com", "cdn.example.net")]),
        )
        self.assertEqual(r.status, "ACCEPT")
        self.assertEqual(r.answers[-1].data, "192.0.2.9")

    def test_loop_rejected_and_not_cached(self):
        r = self.resolver.resolve(
            query("loop1.example.com"),
            response(1, "loop1.example.com",
                     [cname("loop1.example.com", "loop2.example.com"),
                      cname("loop2.example.com", "loop1.example.com")]),
        )
        self.assertEqual(r.status, "REJECT")
        self.assertTrue(any("loop" in reason for reason in r.reasons))
        self.assertEqual(len(self.cache), 0)

    def test_too_deep_chain_rejected(self):
        answers = [cname(f"deep{i}.example.com", f"deep{i+1}.example.com") for i in range(5)]
        answers.append(arec("deep5.example.com"))
        r = self.resolver.resolve(
            query("deep0.example.com"), response(1, "deep0.example.com", answers)
        )
        self.assertEqual(r.status, "REJECT")
        self.assertTrue(any("too deep" in reason for reason in r.reasons))
        self.assertEqual(len(self.cache), 0)

    def test_missing_target_rejected_and_not_cached(self):
        r = self.resolver.resolve(
            query("dangling.example.com"),
            response(1, "dangling.example.com",
                     [cname("dangling.example.com", "missing.example.com")]),
        )
        self.assertEqual(r.status, "REJECT")
        self.assertTrue(any("incomplete" in reason for reason in r.reasons))
        # The incomplete chain must not be served from cache later.
        followup = self.resolver.resolve(query("dangling.example.com", qid=2))
        self.assertEqual(followup.status, "NO_UPSTREAM")

    def test_conflicting_cnames_rejected(self):
        r = self.resolver.resolve(
            query("conflict.example.com"),
            response(1, "conflict.example.com",
                     [cname("conflict.example.com", "a.example.com"),
                      cname("conflict.example.com", "b.example.com"),
                      arec("a.example.com"), arec("b.example.com", "192.0.2.2")]),
        )
        self.assertEqual(r.status, "REJECT")
        self.assertTrue(any("conflicting" in reason for reason in r.reasons))
        self.assertEqual(len(self.cache), 0)

    def test_cname_and_address_for_same_name_rejected(self):
        r = self.resolver.resolve(
            query("both.example.com"),
            response(1, "both.example.com",
                     [cname("both.example.com", "a.example.com"),
                      arec("both.example.com"),
                      arec("a.example.com", "192.0.2.2")]),
        )
        self.assertEqual(r.status, "REJECT")
        self.assertTrue(any("conflicting" in reason for reason in r.reasons))

    def test_chain_records_cached_individually(self):
        self.resolver.resolve(
            query("www.example.com"),
            response(1, "www.example.com",
                     [cname("www.example.com", "cdn.example.net"),
                      arec("cdn.example.net", "192.0.2.9")]),
        )
        # The chain target alone is now answerable from cache.
        r = self.resolver.resolve(query("cdn.example.net", qid=2))
        self.assertEqual(r.status, "CACHE_HIT")

    def test_chain_case_and_trailing_dot_normalised(self):
        r = self.resolver.resolve(
            query("WWW.Example.COM."),
            response(1, "www.example.com",
                     [cname("WWW.EXAMPLE.COM", "CDN.Example.NET."),
                      arec("cdn.example.net", "192.0.2.9")]),
        )
        self.assertEqual(r.status, "ACCEPT")


class TestResolveChainUnit(unittest.TestCase):
    def test_direct_answer(self):
        records, err = resolve_chain(
            "a.example.com", "A", "IN",
            lambda n, t: [arec(n)] if t == "A" else [], 4,
        )
        self.assertIsNone(err)
        self.assertEqual(len(records), 1)

    def test_cname_query_returns_cname_directly(self):
        records, err = resolve_chain(
            "a.example.com", "CNAME", "IN",
            lambda n, t: [cname(n, "b.example.com")] if t == "CNAME" else [], 4,
        )
        self.assertIsNone(err)
        self.assertEqual(records[0].rtype, "CNAME")


if __name__ == "__main__":
    unittest.main()
