import contextlib
import hashlib
import json
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from .config import RULES_VERSION, SCHEMA_VERSION
from .seed import as_bool, as_int, as_json, as_list


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class StorageError(RuntimeError):
    pass


class ConnectionView:
    def __init__(self, connection):
        self.connection = connection

    def query(self, sql, parameters=()):
        return [dict(row) for row in self.connection.execute(sql, parameters).fetchall()]

    def one(self, sql, parameters=()):
        row = self.connection.execute(sql, parameters).fetchone()
        return dict(row) if row else None

    def revision(self):
        row = self.one("SELECT value FROM runtime_meta WHERE key='state_revision'")
        return int(row["value"] if row else 0)


SCHEMA = """
CREATE TABLE IF NOT EXISTS runtime_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS banks(
  bank_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seed_version TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  level_weights_policy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories(
  category_key TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  emoji TEXT NOT NULL,
  active INTEGER NOT NULL,
  quesito_default INTEGER NOT NULL,
  UNIQUE(bank_id, category_id)
);
CREATE TABLE IF NOT EXISTS levels(
  level_key TEXT PRIMARY KEY,
  scale_id TEXT NOT NULL,
  level_id_local TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  probability_weight REAL NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions(
  question_key TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  level_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation TEXT NOT NULL,
  seed_status TEXT NOT NULL,
  source_status TEXT NOT NULL,
  random_order INTEGER NOT NULL,
  order_key TEXT NOT NULL,
  UNIQUE(bank_id, question_id)
);
CREATE INDEX IF NOT EXISTS questions_pool ON questions(bank_id, category_id, level_key, seed_status, order_key);
CREATE TABLE IF NOT EXISTS players(
  player_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches(
  match_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  player_ids_json TEXT NOT NULL,
  enabled_category_ids_json TEXT NOT NULL,
  enabled_level_keys_json TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  level_weights_json TEXT NOT NULL,
  catalog_snapshot_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  source TEXT NOT NULL,
  seed_owned INTEGER NOT NULL,
  owner_session_id TEXT
);
CREATE INDEX IF NOT EXISTS matches_created ON matches(created_at DESC);
CREATE TABLE IF NOT EXISTS participants(
  match_player_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  seat_no INTEGER NOT NULL,
  active INTEGER NOT NULL,
  seed_owned INTEGER NOT NULL,
  UNIQUE(match_id, player_id)
);
CREATE TABLE IF NOT EXISTS historical_attempts(
  attempt_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  question_no INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  level_key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  computable INTEGER NOT NULL,
  correct INTEGER,
  quesito_attempt INTEGER NOT NULL,
  quesito_won INTEGER NOT NULL,
  notes TEXT NOT NULL,
  active INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT
);
CREATE INDEX IF NOT EXISTS attempts_match ON historical_attempts(match_id);
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  action_id TEXT NOT NULL,
  idempotency_key TEXT,
  payload_json TEXT NOT NULL,
  seed_owned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, seq),
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS events_match ON events(match_id, seq);
CREATE TABLE IF NOT EXISTS question_retirements(
  question_key TEXT PRIMARY KEY,
  retired_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL,
  match_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  retired_by_session_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_requests(
  request_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        self.seed_error = None
        self.seed_digest = None
        self._initialize()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=15000")
        return connection

    def _initialize(self):
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, SCHEMA_VERSION}:
                raise StorageError(f"schema SQLite incompatible: {version}")
            connection.executescript(SCHEMA)
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.execute("INSERT OR IGNORE INTO runtime_meta(key,value) VALUES('state_revision','0')")
            connection.execute("INSERT OR REPLACE INTO runtime_meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))

    @contextlib.contextmanager
    def transaction(self):
        with self._write_lock:
            connection = self.connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    @contextlib.contextmanager
    def snapshot(self):
        connection = self.connect()
        try:
            connection.execute("BEGIN")
            yield ConnectionView(connection)
        finally:
            connection.rollback()
            connection.close()

    def query(self, sql, parameters=()):
        with self.connect() as connection:
            return [dict(row) for row in connection.execute(sql, parameters).fetchall()]

    def one(self, sql, parameters=()):
        with self.connect() as connection:
            row = connection.execute(sql, parameters).fetchone()
            return dict(row) if row else None

    def revision(self):
        row = self.one("SELECT value FROM runtime_meta WHERE key='state_revision'")
        return int(row["value"] if row else 0)

    def verify_integrity(self):
        integrity = self.one("PRAGMA integrity_check")
        if not integrity or next(iter(integrity.values())) != "ok":
            raise StorageError(f"integridad SQLite inválida: {integrity}")
        foreign_keys = self.query("PRAGMA foreign_key_check")
        if foreign_keys:
            raise StorageError(f"claves foráneas inválidas: {foreign_keys[:5]}")

    @staticmethod
    def bump_revision(connection):
        connection.execute("UPDATE runtime_meta SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'")

    def sync_seed(self, seed, force=False):
        current = self.one("SELECT value FROM runtime_meta WHERE key='seed_digest'")
        if not force and current and current["value"] == seed.digest:
            self.seed_digest = seed.digest
            self.seed_error = None
            return False
        tables = seed.tables
        player_names = {row["player_id"]: row["name"] for row in tables["players"]}
        category_map = {(row["bank_id"], row["category_id"]): row for row in tables["categories"]}
        level_map = {row["level_key"]: row for row in tables["levels"]}
        with self.transaction() as connection:
            connection.execute("DELETE FROM events WHERE seed_owned=1")
            connection.execute("DELETE FROM participants WHERE seed_owned=1")
            connection.execute("DELETE FROM historical_attempts")
            connection.execute("DELETE FROM matches WHERE seed_owned=1")
            for table in ["questions", "categories", "levels", "banks", "players"]:
                connection.execute(f"DELETE FROM {table}")
            connection.executemany(
                "INSERT INTO banks VALUES(?,?,?,?,?)",
                [(row["bank_id"], row["name"], row["seed_version"], as_int(row["question_count"]), row["level_weights_policy"]) for row in tables["banks"]],
            )
            connection.executemany(
                "INSERT INTO categories VALUES(?,?,?,?,?,?,?,?)",
                [(row["category_key"], row["bank_id"], row["category_id"], row["label"], row["color"], row["emoji"], int(as_bool(row["active"])), int(as_bool(row["quesito_default"]))) for row in tables["categories"]],
            )
            connection.executemany(
                "INSERT INTO levels VALUES(?,?,?,?,?,?,?)",
                [(row["level_key"], row["scale_id"], row["level_id_local"], row["label"], as_int(row["order"]), float(row["probability_weight"]), row["description"]) for row in tables["levels"]],
            )
            connection.executemany(
                "INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                [(row["question_key"], row["bank_id"], row["question_id"], row["category_id"], row["level_key"], row["prompt"], row["answer"], row["explanation"], row["status"], row["source_status"], as_int(row["random_order"]), row["order_key"]) for row in tables["questions"]],
            )
            connection.executemany(
                "INSERT INTO players VALUES(?,?,?)",
                [(row["player_id"], row["name"], int(as_bool(row["active"]))) for row in tables["players"]],
            )
            for row in tables["matches"]:
                player_ids = as_list(row["player_ids"])
                category_ids = as_list(row["enabled_category_ids"])
                level_keys = as_list(row["enabled_level_keys"])
                snapshot = {
                    "players": [{"playerId": player_id, "name": player_names[player_id]} for player_id in player_ids],
                    "categories": [{"categoryId": category_id, "label": category_map[(row["bank_id"], category_id)]["label"], "color": category_map[(row["bank_id"], category_id)]["color"], "emoji": category_map[(row["bank_id"], category_id)]["emoji"]} for category_id in category_ids],
                    "levels": [{"levelKey": level_key, "label": level_map[level_key]["label"]} for level_key in level_keys],
                }
                connection.execute(
                    "INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (row["match_id"], row["name"], row["bank_id"], compact_json(player_ids), compact_json(category_ids), compact_json(level_keys), row["rules_version"], compact_json(as_json(row["level_weights_json"])), compact_json(snapshot), row["seed"], row["status"], row["created_at"], row["closed_at"] or None, row["close_reason"] or None, row["source"], 1, None),
                )
            match_names = {row["match_id"]: json.loads(connection.execute("SELECT catalog_snapshot_json FROM matches WHERE match_id=?", (row["match_id"],)).fetchone()[0]) for row in tables["matches"]}
            for row in tables["participants"]:
                names = {item["playerId"]: item["name"] for item in match_names[row["match_id"]]["players"]}
                connection.execute(
                    "INSERT INTO participants VALUES(?,?,?,?,?,?,?)",
                    (row["match_player_id"], row["match_id"], row["player_id"], names[row["player_id"]], as_int(row["seat_no"], 1), int(as_bool(row["active"])), 1),
                )
            connection.executemany(
                "INSERT INTO historical_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(row["attempt_id"], row["match_id"], as_int(row["question_no"]), row["player_id"], row["question_id"], row["question_key"], row["bank_id"], row["category_id"], row["level_key"], row["result_id"], int(as_bool(row["computable"])), None if row["correct"] == "" else int(as_bool(row["correct"])), int(as_bool(row["quesito_attempt"])), int(as_bool(row["quesito_won"])), row["notes"], int(as_bool(row["active"])), row["source"], row["source_event_id"] or None) for row in tables["attempts"]],
            )
            for row in tables["events"]:
                connection.execute(
                    "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,1)",
                    (row["event_id"], row["match_id"], as_int(row["seq"], 1), row["timestamp"], row["type"], as_int(row["schema_version"], 1), row["action_id"], row["idempotency_key"] or None, compact_json(as_json(row["payload_json"]))),
                )
            connection.execute("DELETE FROM question_retirements WHERE question_key NOT IN (SELECT question_key FROM questions)")
            connection.execute("INSERT OR REPLACE INTO runtime_meta VALUES('seed_version',?)", (seed.seed_version,))
            connection.execute("INSERT OR REPLACE INTO runtime_meta VALUES('seed_digest',?)", (seed.digest,))
            connection.execute("INSERT OR REPLACE INTO runtime_meta VALUES('rules_version',?)", (RULES_VERSION,))
            connection.execute("INSERT OR REPLACE INTO runtime_meta VALUES('seed_synced_at',?)", (utc_now(),))
            self.bump_revision(connection)
        self.seed_digest = seed.digest
        self.seed_error = None
        return True

    def create_session(self):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        session_id = f"S-{secrets.token_hex(12)}"
        now = utc_now()
        with self.transaction() as connection:
            connection.execute("INSERT INTO sessions VALUES(?,?,?,?)", (session_id, token_hash, now, now))
        return session_id, token

    def resolve_session(self, token):
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as connection:
            row = connection.execute("SELECT session_id FROM sessions WHERE token_hash=?", (token_hash,)).fetchone()
            if not row:
                return None
            return row[0]
