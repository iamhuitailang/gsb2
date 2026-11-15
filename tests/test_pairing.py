"""配对核心逻辑测试：跨午夜、乱序输入、LIFO、同时间点排序。"""

import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.pairing import ENTRY, EXIT, Event, pair_events


def ev(eid, lot, plate, etype, ts, gate="G", seq=None):
    return Event(
        event_id=eid,
        lot=lot,
        gate=gate,
        seq=seq if seq is not None else eid,
        plate=plate,
        event_type=etype,
        event_time=datetime.fromisoformat(ts),
    )


class PairingTests(unittest.TestCase):
    def test_cross_midnight_pairing_by_event_time_not_import_order(self):
        # 事件故意按"出场先于进场"的顺序给出，模拟文件乱序到达
        events = [
            ev(2, "P1", "京A12345", EXIT, "2026-11-15T00:20:00"),
            ev(1, "P1", "京A12345", ENTRY, "2026-11-14T23:50:00"),
        ]
        pairs, unpaired = pair_events(events)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0].entry_id, 1)
        self.assertEqual(pairs[0].exit_id, 2)
        self.assertEqual(pairs[0].duration_seconds, 30 * 60)
        self.assertEqual(unpaired, [])

    def test_exit_uses_latest_open_entry_and_one_entry_pairs_once(self):
        events = [
            ev(1, "P1", "A", ENTRY, "2026-11-15T08:00:00"),
            ev(2, "P1", "A", ENTRY, "2026-11-15T09:00:00"),
            ev(3, "P1", "A", EXIT, "2026-11-15T10:00:00"),
        ]
        pairs, unpaired = pair_events(events)
        self.assertEqual(len(pairs), 1)
        self.assertEqual((pairs[0].entry_id, pairs[0].exit_id), (2, 3))
        self.assertEqual(unpaired, [1])  # 一条进场最多配一次

    def test_isolated_by_lot_and_plate(self):
        events = [
            ev(1, "P1", "A", ENTRY, "2026-11-15T08:00:00"),
            ev(2, "P2", "A", EXIT, "2026-11-15T09:00:00"),
            ev(3, "P1", "B", EXIT, "2026-11-15T09:30:00"),
        ]
        pairs, unpaired = pair_events(events)
        self.assertEqual(pairs, [])
        self.assertEqual(sorted(unpaired), [1, 2, 3])

    def test_exit_before_any_entry_stays_unpaired(self):
        events = [
            ev(1, "P1", "A", EXIT, "2026-11-14T22:00:00"),
            ev(2, "P1", "A", ENTRY, "2026-11-14T23:00:00"),
            ev(3, "P1", "A", EXIT, "2026-11-15T01:00:00"),
        ]
        pairs, unpaired = pair_events(events)
        self.assertEqual(len(pairs), 1)
        self.assertEqual((pairs[0].entry_id, pairs[0].exit_id), (2, 3))
        self.assertEqual(unpaired, [1])

    def test_same_timestamp_entry_sorts_before_exit(self):
        events = [
            ev(1, "P1", "A", EXIT, "2026-11-15T09:00:00"),
            ev(2, "P1", "A", ENTRY, "2026-11-15T09:00:00"),
        ]
        pairs, unpaired = pair_events(events)
        # 同时间进场优先：进场被该出场消费
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0].duration_seconds, 0)
        self.assertEqual(unpaired, [])

    def test_two_complete_visits(self):
        events = [
            ev(1, "P1", "A", ENTRY, "2026-11-14T23:50:00"),
            ev(2, "P1", "A", EXIT, "2026-11-15T00:20:00"),
            ev(3, "P1", "A", ENTRY, "2026-11-15T09:10:00"),
            ev(4, "P1", "A", EXIT, "2026-11-15T11:40:00"),
        ]
        pairs, unpaired = pair_events(events)
        self.assertEqual(len(pairs), 2)
        self.assertEqual([p.duration_seconds for p in pairs], [1800, 9000])
        self.assertEqual(unpaired, [])


if __name__ == "__main__":
    unittest.main()
