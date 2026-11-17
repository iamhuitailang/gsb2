import unittest

from dnscheck.model import Question, Record, Response
from dnscheck.validator import validate_response


def q(name="www.example.com", qtype="A", qid=1):
    return Question(name=name, qtype=qtype, qid=qid)


def resp(rid=1, name="www.example.com", qtype="A", answers=(), rcode="NOERROR", with_question=True):
    question = Question(name=name, qtype=qtype) if with_question else None
    return Response(id=rid, rcode=rcode, question=question, answers=tuple(answers))


def a_record(name="www.example.com", ttl=100, data="192.0.2.1"):
    return Record(name=name, rtype="A", rclass="IN", ttl=ttl, data=data)


class TestResponseMatching(unittest.TestCase):
    def test_matching_response_accepted(self):
        problems = validate_response(q(), resp(answers=[a_record()]))
        self.assertEqual(problems, [])

    def test_transaction_id_mismatch_rejected(self):
        problems = validate_response(q(qid=1), resp(rid=2, answers=[a_record()]))
        self.assertTrue(any("transaction id" in p for p in problems))

    def test_name_comparison_ignores_case_and_trailing_dot(self):
        problems = validate_response(
            q(name="WWW.Example.COM."), resp(name="www.example.com", answers=[a_record()])
        )
        self.assertEqual(problems, [])

    def test_question_name_mismatch_rejected(self):
        problems = validate_response(q(), resp(name="other.example.com", answers=[a_record()]))
        self.assertTrue(any("name mismatch" in p for p in problems))

    def test_question_type_mismatch_rejected(self):
        problems = validate_response(q(), resp(qtype="AAAA", answers=[a_record()]))
        self.assertTrue(any("type mismatch" in p for p in problems))

    def test_missing_question_section_rejected(self):
        problems = validate_response(q(), resp(with_question=False, answers=[a_record()]))
        self.assertTrue(any("no question section" in p for p in problems))

    def test_bare_unrelated_address_record_not_accepted(self):
        # A response that merely contains *some* A record, for a name the
        # query never asked about, must not validate.
        problems = validate_response(
            q(), resp(answers=[a_record(name="unrelated.example.org")])
        )
        self.assertTrue(any("unrelated name" in p for p in problems))

    def test_cname_chain_records_are_relevant(self):
        answers = [
            Record(name="www.example.com", rtype="CNAME", rclass="IN", ttl=100, data="cdn.example.net"),
            Record(name="cdn.example.net", rtype="A", rclass="IN", ttl=100, data="192.0.2.9"),
        ]
        problems = validate_response(q(), resp(answers=answers))
        self.assertEqual(problems, [])

    def test_wrong_class_rejected(self):
        rec = Record(name="www.example.com", rtype="A", rclass="IN", ttl=100, data="192.0.2.1")
        response = Response(
            id=1,
            rcode="NOERROR",
            question=Question(name="www.example.com", qtype="A"),
            answers=(rec,),
        )
        problems = validate_response(q(), response)
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
