"""领域逻辑测试：重点是场景要求的越权与幂等行为。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ticket_system import service
from ticket_system.db import init_db
from ticket_system.seed import DEMO_TICKET_TITLE, seed_demo


class ServiceTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "test.db")
        self.conn = init_db(self.db_path)
        self.ids = seed_demo(self.conn)
        self.supervisor_a = service.authenticate(
            self.conn, "supervisor_a", "demo1234"
        )
        self.supervisor_b = service.authenticate(
            self.conn, "supervisor_b", "demo1234"
        )
        self.admin = service.authenticate(self.conn, "admin", "demo1234")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def status(self, ticket_id: int) -> str:
        return service.get_ticket(self.conn, ticket_id)["status"]


class PreviewTest(ServiceTestBase):
    def test_counts_only_own_open_tickets_and_hides_foreign_title(self) -> None:
        foreign = self.ids["ticket_other_group"]
        result = service.preview_batch(
            self.conn,
            self.supervisor_a,
            [self.ids["ticket_first"], foreign],
        )
        self.assertEqual(result["closable_count"], 1)
        foreign_item = next(
            item for item in result["items"] if item["ticket_id"] == foreign
        )
        self.assertEqual(foreign_item["reason"], "no_permission")
        self.assertNotIn("title", foreign_item)
        self.assertNotIn("status", foreign_item)

    def test_archived_ticket_is_not_closable(self) -> None:
        ticket = self.ids["ticket_first"]
        service.set_ticket_status(self.conn, ticket, "archived")
        result = service.preview_batch(self.conn, self.supervisor_a, [ticket])
        self.assertEqual(result["closable_count"], 0)
        self.assertEqual(result["items"][0]["reason"], "archived")

    def test_agent_cannot_preview(self) -> None:
        agent_id = service.create_user(
            self.conn, "agent_a", "demo1234", "agent", self.ids["group_a"]
        )
        agent = service.get_user(self.conn, agent_id)
        with self.assertRaises(service.ApiError) as ctx:
            service.preview_batch(self.conn, agent, [self.ids["ticket_first"]])
        self.assertEqual(ctx.exception.status, 403)

    def test_preview_does_not_change_state(self) -> None:
        ticket = self.ids["ticket_first"]
        service.preview_batch(self.conn, self.supervisor_a, [ticket])
        self.assertEqual(self.status(ticket), "open")
        self.assertEqual(service.count_close_records(self.conn, ticket), 0)


class CloseBatchScenarioTest(ServiceTestBase):
    """题目场景：预览后把甲组第二张转到乙组，再提交三张编号。"""

    def test_transfer_after_preview_only_closes_first(self) -> None:
        first = self.ids["ticket_first"]
        second = self.ids["ticket_second"]
        foreign = self.ids["ticket_other_group"]

        preview = service.preview_batch(
            self.conn, self.supervisor_a, [first, second, foreign]
        )
        self.assertEqual(preview["closable_count"], 2)

        service.transfer_ticket(
            self.conn, self.admin, second, self.ids["group_b"]
        )

        result = service.close_batch(
            self.conn, self.supervisor_a, [first, second, foreign], "batch-1"
        )

        self.assertEqual([item["ticket_id"] for item in result["closed"]], [first])
        self.assertEqual(self.status(first), "closed")
        self.assertEqual(self.status(second), "open")
        self.assertEqual(self.status(foreign), "open")

        unprocessed = {item["ticket_id"]: item for item in result["unprocessed"]}
        self.assertEqual(set(unprocessed), {second, foreign})
        for ticket_id in (second, foreign):
            item = unprocessed[ticket_id]
            self.assertEqual(item["reason"], "no_permission")
            self.assertNotIn("title", item)
            self.assertNotIn("status", item)
            self.assertNotIn(DEMO_TICKET_TITLE, json.dumps(item, ensure_ascii=False))

        self.assertEqual(service.count_close_records(self.conn, first), 1)
        self.assertEqual(service.count_close_records(self.conn, second), 0)

    def test_duplicate_submission_writes_no_extra_records(self) -> None:
        first = self.ids["ticket_first"]
        args = ([first], "same-batch")
        first_result = service.close_batch(self.conn, self.supervisor_a, *args)
        second_result = service.close_batch(self.conn, self.supervisor_a, *args)

        self.assertFalse(first_result["replayed"])
        self.assertTrue(second_result["replayed"])
        self.assertEqual(first_result["closed"], second_result["closed"])
        self.assertEqual(service.count_close_records(self.conn, first), 1)
        audits = [a for a in service.audit_log(self.conn, first) if a["action"] == "close"]
        self.assertEqual(len(audits), 1)

    def test_batch_key_reuse_with_different_ids_conflicts(self) -> None:
        service.close_batch(
            self.conn, self.supervisor_a, [self.ids["ticket_first"]], "k"
        )
        with self.assertRaises(service.ApiError) as ctx:
            service.close_batch(
                self.conn, self.supervisor_a, [self.ids["ticket_second"]], "k"
            )
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(self.status(self.ids["ticket_second"]), "open")

    def test_archived_ticket_stays_untouched(self) -> None:
        ticket = self.ids["ticket_first"]
        service.set_ticket_status(self.conn, ticket, "archived")
        result = service.close_batch(self.conn, self.supervisor_a, [ticket], "b")
        self.assertEqual(result["closed_count"], 0)
        self.assertEqual(result["unprocessed"][0]["reason"], "archived")
        self.assertEqual(self.status(ticket), "archived")
        self.assertEqual(service.count_close_records(self.conn, ticket), 0)

    def test_other_group_ticket_cannot_be_closed(self) -> None:
        foreign = self.ids["ticket_other_group"]
        result = service.close_batch(
            self.conn, self.supervisor_a, [foreign], "foreign-batch"
        )
        self.assertEqual(result["closed_count"], 0)
        self.assertEqual(self.status(foreign), "open")
        self.assertEqual(service.count_close_records(self.conn, foreign), 0)

    def test_foreign_archived_ticket_reports_only_no_permission(self) -> None:
        """权限先于状态判定：组外归档工单也不能泄露“已归档”。"""
        foreign = self.ids["ticket_other_group"]
        service.set_ticket_status(self.conn, foreign, "archived")
        result = service.close_batch(
            self.conn, self.supervisor_a, [foreign], "foreign-archived"
        )
        item = result["unprocessed"][0]
        self.assertEqual(item["reason"], "no_permission")
        self.assertNotIn("status", item)
        self.assertNotIn("title", item)
        self.assertEqual(self.status(foreign), "archived")

    def test_own_closed_ticket_is_reported_as_already_closed(self) -> None:
        first = self.ids["ticket_first"]
        service.close_batch(self.conn, self.supervisor_a, [first], "first-batch")
        result = service.close_batch(
            self.conn, self.supervisor_a, [first], "second-batch"
        )
        self.assertEqual(result["closed_count"], 0)
        self.assertEqual(result["unprocessed"][0]["reason"], "already_closed")
        self.assertEqual(service.count_close_records(self.conn, first), 1)

    def test_nonexistent_id_is_indistinguishable_from_foreign(self) -> None:
        result = service.close_batch(
            self.conn, self.supervisor_a, [999_999], "ghost"
        )
        item = result["unprocessed"][0]
        self.assertEqual(item, {"ticket_id": 999_999, "reason": "no_permission"})

    def test_duplicate_ids_in_one_request_are_deduped(self) -> None:
        first = self.ids["ticket_first"]
        result = service.close_batch(
            self.conn, self.supervisor_a, [first, first], "dedupe"
        )
        self.assertEqual(result["closed_count"], 1)
        self.assertEqual(service.count_close_records(self.conn, first), 1)

    def test_invalid_ids_are_rejected(self) -> None:
        for bad in ([], [0], ["1"], [True], None, "1"):
            with self.assertRaises(service.ApiError):
                service.close_batch(self.conn, self.supervisor_a, bad, "bad")
        self.assertEqual(self.status(self.ids["ticket_first"]), "open")

    def test_archived_ticket_cannot_be_transferred(self) -> None:
        ticket = self.ids["ticket_first"]
        service.set_ticket_status(self.conn, ticket, "archived")
        with self.assertRaises(service.ApiError) as ctx:
            service.transfer_ticket(self.conn, self.admin, ticket, self.ids["group_b"])
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(
            service.get_ticket(self.conn, ticket)["group_id"], self.ids["group_a"]
        )


class PaginationTest(ServiceTestBase):
    def test_pages_cover_group_only(self) -> None:
        page1 = service.list_group_tickets(
            self.conn, group_id=self.ids["group_a"], page=1, page_size=1
        )
        page2 = service.list_group_tickets(
            self.conn, group_id=self.ids["group_a"], page=2, page_size=1
        )
        self.assertEqual(page1["total"], 2)
        self.assertEqual(page1["total_pages"], 2)
        ids = {page1["items"][0]["ticket_id"], page2["items"][0]["ticket_id"]}
        self.assertEqual(ids, {self.ids["ticket_first"], self.ids["ticket_second"]})
        self.assertNotIn(self.ids["ticket_other_group"], ids)

    def test_bad_pagination_rejected(self) -> None:
        with self.assertRaises(service.ApiError):
            service.list_group_tickets(
                self.conn, group_id=self.ids["group_a"], page=0, page_size=10
            )
        with self.assertRaises(service.ApiError):
            service.list_group_tickets(
                self.conn, group_id=self.ids["group_a"], page=1, page_size=0
            )


if __name__ == "__main__":
    unittest.main()
