import unittest

from dnscheck.cache import DnsCache
from dnscheck.clock import Clock
from dnscheck.model import Question, Record, Response
from dnscheck.resolver import Resolver


def question(name="www.example.com", qtype="A", qid=1):
    return Question(name=name, qtype=qtype, qid=qid)


def ok_response(rid=1, name="www.example.com", qtype="A", answers=()):
    return Response(
        id=rid,
        rcode="NOERROR",
        question=Question(name=name, qtype=qtype),
        answers=tuple(answers),
    )


def rcode_response(rid, rcode, name="www.example.com", qtype="A"):
    return Response(
        id=rid, rcode=rcode, question=Question(name=name, qtype=qtype), answers=()
    )


def a_rec(name="www.example.com", ttl=100, data="192.0.2.1"):
    return Record(name=name, rtype="A", rclass="IN", ttl=ttl, data=data)


class TestResolverBasic(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(0)
        self.cache = DnsCache(self.clock, max_ttl=300, negative_ttl=60)
        self.resolver = Resolver(self.cache)

    def test_accept_then_cache_hit(self):
        r1 = self.resolver.resolve(
            question(qid=1), ok_response(rid=1, answers=[a_rec()])
        )
        self.assertEqual(r1.status, "ACCEPT")
        r2 = self.resolver.resolve(question(qid=2))
        self.assertEqual(r2.status, "CACHE_HIT")
        self.assertEqual(r2.answers[0].data, "192.0.2.1")

    def test_expired_entry_triggers_refresh(self):
        self.resolver.resolve(question(qid=1), ok_response(rid=1, answers=[a_rec(ttl=50)]))
        self.clock.advance(51)
        r = self.resolver.resolve(
            question(qid=2), ok_response(rid=2, answers=[a_rec(data="192.0.2.2")])
        )
        self.assertEqual(r.status, "ACCEPT")
        self.assertEqual(r.answers[0].data, "192.0.2.2")

    def test_rejected_response_not_cached(self):
        bad = Response(
            id=99,  # id mismatch
            rcode="NOERROR",
            question=Question(name="www.example.com", qtype="A"),
            answers=(a_rec(),),
        )
        r = self.resolver.resolve(question(qid=1), bad)
        self.assertEqual(r.status, "REJECT")
        self.assertEqual(len(self.cache), 0)
        followup = self.resolver.resolve(question(qid=2))
        self.assertEqual(followup.status, "NO_UPSTREAM")

    def test_nxdomain_cached_with_negative_semantics(self):
        r1 = self.resolver.resolve(question(qid=1), rcode_response(1, "NXDOMAIN"))
        self.assertEqual(r1.status, "NXDOMAIN")
        r2 = self.resolver.resolve(question(qid=2))
        self.assertEqual(r2.status, "CACHE_HIT_NXDOMAIN")

    def test_nxdomain_cache_expires(self):
        self.resolver.resolve(question(qid=1), rcode_response(1, "NXDOMAIN"))
        self.clock.advance(61)
        r = self.resolver.resolve(question(qid=2))
        self.assertEqual(r.status, "NO_UPSTREAM")

    def test_servfail_not_cached(self):
        r1 = self.resolver.resolve(question(qid=1), rcode_response(1, "SERVFAIL"))
        self.assertEqual(r1.status, "SERVFAIL")
        self.assertEqual(len(self.cache), 0)
        r2 = self.resolver.resolve(question(qid=2))
        self.assertEqual(r2.status, "NO_UPSTREAM")

    def test_servfail_does_not_erase_valid_positive(self):
        self.resolver.resolve(question(qid=1), ok_response(rid=1, answers=[a_rec()]))
        # Cache is checked first, so a later SERVFAIL never even reaches storage.
        r = self.resolver.resolve(question(qid=2), rcode_response(2, "SERVFAIL"))
        self.assertEqual(r.status, "CACHE_HIT")

    def test_no_upstream_sample_on_miss(self):
        r = self.resolver.resolve(question(qid=1))
        self.assertEqual(r.status, "NO_UPSTREAM")

    def test_different_queries_do_not_share_responses(self):
        # A response belonging to another question must not be accepted,
        # even with a matching transaction id.
        other = Response(
            id=1,
            rcode="NOERROR",
            question=Question(name="other.example.com", qtype="A"),
            answers=(a_rec(name="other.example.com"),),
        )
        r = self.resolver.resolve(question(qid=1), other)
        self.assertEqual(r.status, "REJECT")
        self.assertEqual(len(self.cache), 0)


if __name__ == "__main__":
    unittest.main()
