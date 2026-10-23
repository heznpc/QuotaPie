import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "watch", Path(__file__).resolve().parents[1] / "scripts/watch-wake-evidence.py")
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "events.jsonl"
        self.path.write_text(json.dumps({"kind": "observer-started", "pid": 123,
                                        "atMs": 1, "expiresAtMs": 900}) + "\n")
        self.state = watch.consume(self.path, {})

    def test_waiting_does_not_notify_or_consume_again(self):
        offset = self.state["offset"]
        watch.consume(self.path, self.state)
        self.assertEqual(self.state["offset"], offset)
        self.assertIsNone(watch.notice(self.state, 10, lambda _: True))

    def test_partial_line_is_retried_and_completion_notified_once(self):
        with self.path.open("a") as stream:
            stream.write('{"kind":"cycle-observed","atMs":20')
        offset = self.state["offset"]
        watch.consume(self.path, self.state)
        self.assertEqual(self.state["offset"], offset)
        self.assertIsNone(watch.notice(self.state, 30, lambda _: True))
        with self.path.open("a") as stream:
            stream.write('}\n')
        watch.consume(self.path, self.state)
        result = watch.notice(self.state, 30, lambda _: False)
        self.assertIn("새 잠자기", result[1])
        self.state["notified"] = result[0]
        self.assertIsNone(watch.notice(self.state, 30, lambda _: False))

    def test_rotated_log_starts_a_new_observer(self):
        self.state["event"] = {"kind": "cycle-observed", "atMs": 20}
        replacement = self.path.with_suffix(".new")
        replacement.write_text(json.dumps({"kind": "observer-started", "pid": 456,
                                           "atMs": 40, "expiresAtMs": 900}) + "\n")
        replacement.replace(self.path)
        watch.consume(self.path, self.state)
        self.assertEqual(self.state["observer"]["pid"], 456)
        self.assertIsNone(watch.notice(self.state, 50, lambda _: True))

    def test_stopped_and_expired_observers_are_actionable(self):
        self.assertIn("observer-stopped", watch.notice(self.state, 50, lambda _: False)[1])
        self.assertIn("observer-expired", watch.notice(self.state, 901, lambda _: True)[1])

    def test_atomic_state_roundtrip(self):
        path = self.path.with_suffix(".state")
        watch.save(path, self.state)
        self.assertEqual(json.loads(path.read_text()), self.state)


if __name__ == "__main__":
    unittest.main()
