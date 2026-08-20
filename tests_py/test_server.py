import itertools
import json
import shutil
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from server.api import SeedWatcher
from server.config import DATA_DIR
from server.domain import GameError, GameService, deterministic_unit
from server.maintenance import create_backup, diagnose, reset_to_seed, restore_backup, validate_backup
from server.seed import load_seed
from server.statistics import compute_statistics, fisher_exact, wilson
from server.storage import Database


BANK = "B2026-08-18"
LEVELS = ["S_DIFICULTAD_TRIVIAL_V1|CUR", "S_DIFICULTAD_TRIVIAL_V1|AUT", "S_DIFICULTAD_TRIVIAL_V1|NIC"]
CATEGORIES = ["AL", "LI", "FI", "HI", "IN", "NE"]
PLAYERS = ["J1", "J2", "J3"]


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name) / "trivial.sqlite3")
        self.seed = load_seed(DATA_DIR)
        self.database.sync_seed(self.seed)
        self.session_id, self.session_token = self.database.create_session()
        self.games = GameService(self.database)
        self.counter = 0

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, prefix="request"):
        self.counter += 1
        return f"{prefix}-{self.counter:06d}"

    def create(self, players=None, categories=None, levels=None):
        payload = {"bankId": BANK, "playerIds": players or ["J1", "J3"], "categoryIds": categories or ["AL", "IN"], "levelKeys": levels or LEVELS, "name": "Prueba"}
        return self.games.create_match(self.session_id, payload, self.request("create"))

    def action(self, match_id, payload, request=None):
        return self.games.perform_action(match_id, self.session_id, payload, request or self.request("action"))

    def prepare_draw(self, match_id, player="J3", category="AL", quesito=False):
        self.action(match_id, {"action": "select_turn", "playerId": player})
        return self.action(match_id, {"action": "draw", "categoryId": category, "quesitoAttempt": quesito})

    def test_seed_csv_and_integrity(self):
        self.assertEqual(len(self.seed.tables["questions"]), 726)
        self.assertEqual(len({row["question_key"] for row in self.seed.tables["questions"]}), 726)
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM questions")["count"], 726)
        result = diagnose(self.database, {"error": None})
        self.assertTrue(result["ok"], result["errors"])

    def test_all_player_combinations(self):
        for size in range(1, 4):
            for combination in itertools.combinations(PLAYERS, size):
                detail = self.create(players=list(combination), categories=["AL"], levels=[LEVELS[0]])
                self.assertEqual(detail["match"]["playerIds"], list(combination))

    def test_all_nonempty_category_and_level_subsets_have_validation(self):
        for category_size in range(1, len(CATEGORIES) + 1):
            for categories in itertools.combinations(CATEGORIES, category_size):
                for level_size in range(1, len(LEVELS) + 1):
                    for levels in itertools.combinations(LEVELS, level_size):
                        placeholders = ",".join("?" for _ in levels)
                        for category in categories:
                            count = self.database.one(f"SELECT COUNT(*) count FROM questions WHERE bank_id=? AND category_id=? AND level_key IN ({placeholders}) AND seed_status='active'", [BANK, category, *levels])["count"]
                            self.assertGreater(count, 0)

    def test_manual_turn_freezes_draw_and_never_rotates(self):
        match_id = self.create()["match"]["matchId"]
        drawn = self.prepare_draw(match_id, "J3", "IN")
        self.assertEqual(drawn["state"]["currentDraw"]["playerId"], "J3")
        with self.assertRaises(GameError):
            self.action(match_id, {"action": "select_turn", "playerId": "J1"})
        self.action(match_id, {"action": "reveal"})
        finished = self.action(match_id, {"action": "result", "playerId": "J3", "correct": False})
        self.assertIsNone(finished["state"]["currentTurnPlayerId"])
        self.assertIsNone(finished["state"]["currentDraw"])

    def test_prng_weights_exhaustion_and_order(self):
        self.assertEqual(deterministic_unit("seed", 3, "J1", "AL"), deterministic_unit("seed", 3, "J1", "AL"))
        detail = self.create(categories=["AL"], levels=[LEVELS[0]])
        match_id = detail["match"]["matchId"]
        expected = self.database.one("SELECT q.question_key FROM questions q LEFT JOIN question_retirements r ON r.question_key=q.question_key WHERE q.bank_id=? AND q.category_id='AL' AND q.level_key=? AND q.seed_status='active' AND r.question_key IS NULL ORDER BY q.order_key,q.question_key LIMIT 1", (BANK, LEVELS[0]))["question_key"]
        drawn = self.prepare_draw(match_id, "J1", "AL")
        self.assertEqual(drawn["state"]["currentDraw"]["questionKey"], expected)
        self.assertEqual(drawn["state"]["currentDraw"]["effectiveWeights"], {LEVELS[0]: 70.0})
        second = self.create(categories=["AL"], levels=[LEVELS[0], LEVELS[1]])
        second_id = second["match"]["matchId"]
        with self.database.transaction() as connection:
            rows = connection.execute("SELECT question_key FROM questions WHERE bank_id=? AND category_id='AL' AND level_key=? AND seed_status='active'", (BANK, LEVELS[0])).fetchall()
            for row in rows:
                connection.execute("INSERT OR IGNORE INTO question_retirements VALUES(?,?,?,?,?,?,?)", (row[0], "2026-08-20T00:00:00Z", "agotada", "", second_id, "test", self.session_id))
        exhausted = self.prepare_draw(second_id, "J1", "AL")
        self.assertEqual(exhausted["state"]["currentDraw"]["levelKey"], LEVELS[1])
        self.assertEqual(set(exhausted["state"]["currentDraw"]["effectiveWeights"]), {LEVELS[1]})
        self.assertEqual(second["match"]["levelWeights"]["AL"], {LEVELS[0]: 70.0, LEVELS[1]: 20.0})

    def test_quesito_discard_undo_redo_and_replay(self):
        match_id = self.create(categories=["AL", "IN"], levels=[LEVELS[0]])["match"]["matchId"]
        first = self.prepare_draw(match_id, "J3", "AL", True)["state"]["currentDraw"]
        discarded = self.action(match_id, {"action": "discard", "reason": "ambigua", "note": "No es inequívoca"})
        replacement = discarded["state"]["currentDraw"]
        self.assertNotEqual(first["questionKey"], replacement["questionKey"])
        self.assertEqual(first["levelKey"], replacement["levelKey"])
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM question_retirements")["count"], 1)
        discard_undone = self.action(match_id, {"action": "undo"})
        self.assertEqual(discard_undone["state"]["currentDraw"]["questionKey"], first["questionKey"])
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM question_retirements")["count"], 1)
        discard_redone = self.action(match_id, {"action": "redo"})
        self.assertEqual(discard_redone["state"]["currentDraw"]["questionKey"], replacement["questionKey"])
        self.action(match_id, {"action": "reveal"})
        request = self.request("result")
        result = self.action(match_id, {"action": "result", "playerId": "J1", "correct": True}, request)
        repeated = self.action(match_id, {"action": "result", "playerId": "J1", "correct": True}, request)
        self.assertEqual(result, repeated)
        self.assertEqual(result["marker"][0]["quesitos"], ["AL"])
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM events WHERE match_id=? AND type='RESULT_RECORDED'", (match_id,))["count"], 1)
        undone = self.action(match_id, {"action": "undo"})
        self.assertIsNotNone(undone["state"]["currentDraw"])
        self.assertEqual(undone["marker"][0]["quesitos"], [])
        redone = self.action(match_id, {"action": "redo"})
        self.assertIsNone(redone["state"]["currentDraw"])
        self.assertEqual(redone["marker"][0]["quesitos"], ["AL"])
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM question_retirements")["count"], 1)

    def test_atomic_failure_recovery_and_concurrency(self):
        match_id = self.create()["match"]["matchId"]
        self.action(match_id, {"action": "select_turn", "playerId": "J1"})
        before = self.database.one("SELECT COUNT(*) count FROM events WHERE match_id=?", (match_id,))["count"]
        with self.assertRaises(RuntimeError):
            with self.database.transaction() as connection:
                connection.execute("INSERT INTO events(event_id,match_id,seq,timestamp,type,schema_version,action_id,payload_json,seed_owned) VALUES('broken',?,99,'x','TURN_SELECTED',3,'x','{}',0)", (match_id,))
                raise RuntimeError("fallo simulado")
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM events WHERE match_id=?", (match_id,))["count"], before)
        barrier = threading.Barrier(2)

        def draw(index):
            barrier.wait()
            try:
                return self.games.perform_action(match_id, self.session_id, {"action": "draw", "categoryId": "AL", "quesitoAttempt": False}, f"parallel-{index:03d}")
            except GameError as error:
                return error.code

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(draw, [1, 2]))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn("PENDING_QUESTION", results)
        seqs = [row["seq"] for row in self.database.query("SELECT seq FROM events WHERE match_id=?", (match_id,))]
        self.assertEqual(len(seqs), len(set(seqs)))
        with self.database.transaction() as connection:
            connection.execute("UPDATE matches SET status='closed',closed_at='x',close_reason='x' WHERE match_id=?", (match_id,))
        self.assertTrue(self.games.reconcile_all())
        repaired = self.database.one("SELECT status,closed_at,close_reason FROM matches WHERE match_id=?", (match_id,))
        self.assertEqual(repaired, {"status": "open", "closed_at": None, "close_reason": None})

    def test_seed_migration_preserves_web_matches(self):
        match_id = self.create()["match"]["matchId"]
        with tempfile.TemporaryDirectory() as copy:
            target = Path(copy) / "data"
            shutil.copytree(DATA_DIR, target)
            meta = (target / "meta.csv").read_text(encoding="utf-8").replace('"2026-08-20.1"', '"2026-08-20.test"')
            banks = (target / "banks.csv").read_text(encoding="utf-8").replace('"2026-08-20.1"', '"2026-08-20.test"')
            (target / "meta.csv").write_bytes(meta.replace("\r\n", "\n").replace("\n", "\r\n").encode())
            (target / "banks.csv").write_bytes(banks.replace("\r\n", "\n").replace("\n", "\r\n").encode())
            migrated = load_seed(target)
            self.assertTrue(self.database.sync_seed(migrated))
        self.assertIsNotNone(self.database.one("SELECT match_id FROM matches WHERE match_id=?", (match_id,)))
        self.assertEqual(self.database.one("SELECT value FROM runtime_meta WHERE key='seed_version'")["value"], "2026-08-20.test")

    def test_seed_watcher_updates_automatically_and_rejects_invalid_csv(self):
        with tempfile.TemporaryDirectory() as copy:
            target = Path(copy) / "data"
            shutil.copytree(DATA_DIR, target)
            watcher = SeedWatcher(self.database, target)
            watcher.refresh(force=True)
            for name in ["meta.csv", "banks.csv"]:
                path = target / name
                content = path.read_text(encoding="utf-8").replace("2026-08-20.1", "2026-08-20.watcher")
                path.write_bytes(content.replace("\r\n", "\n").replace("\n", "\r\n").encode())
            self.assertTrue(watcher.refresh())
            self.assertEqual(self.database.one("SELECT value FROM runtime_meta WHERE key='seed_version'")["value"], "2026-08-20.watcher")
            (target / "meta.csv").write_text('"key","value"\n', encoding="utf-8")
            self.assertFalse(watcher.refresh(force=True))
            self.assertIn("CRLF", watcher.error)
            self.assertEqual(self.database.one("SELECT value FROM runtime_meta WHERE key='seed_version'")["value"], "2026-08-20.watcher")

    def test_backup_restore_and_reset(self):
        match_id = self.create()["match"]["matchId"]
        self.prepare_draw(match_id, "J1", "AL")
        self.action(match_id, {"action": "discard", "reason": "comprometida"})
        backup = create_backup(self.database)
        self.assertEqual(validate_backup(self.database, backup), [])
        broken = json.loads(json.dumps(backup))
        broken["events"].append(dict(broken["events"][0]))
        self.assertIn("event_id vacío o duplicado", validate_backup(self.database, broken))
        malformed = json.loads(json.dumps(backup))
        malformed["events"][0]["payload_json"] = "[]"
        self.assertTrue(any("evento inválido" in error for error in validate_backup(self.database, malformed)))
        reset_to_seed(self.database)
        self.assertIsNone(self.database.one("SELECT match_id FROM matches WHERE match_id=?", (match_id,)))
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM question_retirements")["count"], 0)
        restore_backup(self.database, backup, self.session_id)
        self.assertIsNotNone(self.database.one("SELECT match_id FROM matches WHERE match_id=?", (match_id,)))
        self.assertEqual(self.database.one("SELECT COUNT(*) count FROM question_retirements")["count"], 1)

    def test_statistics_exclude_reverted_and_use_exact_inference(self):
        before = compute_statistics(self.database)
        match_id = self.create(categories=["AL", "IN"], levels=[LEVELS[0]])["match"]["matchId"]
        self.prepare_draw(match_id, "J1", "AL")
        self.action(match_id, {"action": "reveal"})
        self.action(match_id, {"action": "result", "playerId": "J1", "correct": True})
        after = compute_statistics(self.database)
        self.assertEqual(next(row for row in after["byPlayer"] if row["playerId"] == "J1")["attempts"], next(row for row in before["byPlayer"] if row["playerId"] == "J1")["attempts"] + 1)
        self.action(match_id, {"action": "undo"})
        reverted = compute_statistics(self.database)
        self.assertEqual(next(row for row in reverted["byPlayer"] if row["playerId"] == "J1")["attempts"], next(row for row in before["byPlayer"] if row["playerId"] == "J1")["attempts"])
        self.assertLess(wilson(5, 10)["low"], 0.5)
        self.assertGreater(fisher_exact(10, 0, 0, 10), 0)


if __name__ == "__main__":
    unittest.main()
