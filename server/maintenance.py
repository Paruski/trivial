import json
from collections import Counter

from .config import EVENT_SCHEMA_VERSION, EVENT_TYPES, LOW_STOCK_THRESHOLD, RULES_VERSION, SCHEMA_VERSION
from .domain import _parse_event, _parse_match, active_events, derive_state
from .storage import ConnectionView, utc_now


BACKUP_VERSION = 1


def diagnose(database, seed_status):
    with database.snapshot() as snapshot:
        return _diagnose(snapshot, seed_status)


def _diagnose(database, seed_status):
    errors = []
    warnings = []

    def add(target, error_type, identifier, detail):
        target.append({"type": error_type, "id": str(identifier), "detail": str(detail)})

    integrity = database.one("PRAGMA integrity_check")
    if not integrity or next(iter(integrity.values())) != "ok":
        add(errors, "SQLITE_INTEGRITY", "database", integrity)
    for row in database.query("PRAGMA foreign_key_check"):
        add(errors, "FOREIGN_KEY", f'{row.get("table")}:{row.get("rowid")}', row.get("parent"))
    expected = database.one("SELECT COALESCE(SUM(question_count),0) count FROM banks")["count"]
    actual = database.one("SELECT COUNT(*) count FROM questions")["count"]
    if expected != actual:
        add(errors, "QUESTION_COUNT", "questions", f"{actual} != {expected}")
    for row in database.query("SELECT event_id,COUNT(*) count FROM events GROUP BY event_id HAVING count>1"):
        add(errors, "DUPLICATE_EVENT_ID", row["event_id"], row["count"])
    for row in database.query("SELECT match_id,seq,COUNT(*) count FROM events GROUP BY match_id,seq HAVING count>1"):
        add(errors, "DUPLICATE_SEQ", f'{row["match_id"]}:{row["seq"]}', row["count"])
    match_ids = {row["match_id"] for row in database.query("SELECT match_id FROM matches")}
    question_keys = {row["question_key"] for row in database.query("SELECT question_key FROM questions")}
    participant_pairs = {(row["match_id"], row["player_id"]) for row in database.query("SELECT match_id,player_id FROM participants WHERE active=1")}
    for row in database.query("SELECT event_id,match_id FROM events"):
        if row["match_id"] not in match_ids:
            add(errors, "ORPHAN_EVENT", row["event_id"], row["match_id"])
    for row in database.query("SELECT attempt_id,match_id,player_id,question_key FROM historical_attempts"):
        if row["match_id"] not in match_ids or row["question_key"] not in question_keys or (row["match_id"], row["player_id"]) not in participant_pairs:
            add(errors, "ORPHAN_ATTEMPT", row["attempt_id"], f'{row["match_id"]}|{row["player_id"]}|{row["question_key"]}')
    for row in database.query("SELECT event_id,schema_version FROM events WHERE schema_version<>?", (EVENT_SCHEMA_VERSION,)):
        add(errors, "EVENT_SCHEMA_VERSION", row["event_id"], row["schema_version"])
    for match_id in match_ids:
        match_row = database.one("SELECT * FROM matches WHERE match_id=?", (match_id,))
        match = _parse_match(match_row)
        events = [_parse_event(row) for row in database.query("SELECT * FROM events WHERE match_id=? ORDER BY seq", (match_id,))]
        draws = {event["eventId"] for event in events if event["type"] == "QUESTION_DRAWN"}
        for event in events:
            if event["type"] in {"ANSWER_REVEALED", "RESULT_RECORDED", "QUESTION_DISCARDED"} and event["payload"].get("drawEventId") not in draws:
                add(errors, "ORPHAN_TERMINAL", event["eventId"], event["payload"].get("drawEventId"))
        active = active_events(events)
        terminal_counts = Counter(event["payload"].get("drawEventId") for event in active if event["type"] in {"RESULT_RECORDED", "QUESTION_DISCARDED"})
        for draw_id, count in terminal_counts.items():
            if count > 1:
                add(errors, "DUPLICATE_TERMINAL", draw_id, count)
        state = derive_state(match, events)
        if state["status"] != match["status"]:
            add(errors, "PROJECTION_STATUS", match_id, f'{match["status"]} != {state["status"]}')
        if state["currentDraw"] and state["currentDraw"]["eventId"] not in draws:
            add(errors, "INCOHERENT_PENDING", match_id, state["currentDraw"]["eventId"])
        owned = set()
        for event in active:
            if event["type"] != "RESULT_RECORDED" or not event["payload"].get("quesitoWon"):
                continue
            payload = event["payload"]
            if not payload.get("correct") or not payload.get("quesitoAttempt"):
                add(errors, "INCOHERENT_QUESITO", event["eventId"], "quesito sin acierto/intento")
            if payload.get("playerId") not in match["playerIds"] or payload.get("categoryId") not in match["enabledCategoryIds"]:
                add(errors, "INCOHERENT_QUESITO", event["eventId"], "jugador o categoría fuera de la partida")
            key = (payload.get("playerId"), payload.get("categoryId"))
            if key in owned:
                add(errors, "DUPLICATE_QUESITO", event["eventId"], f"{key[0]}:{key[1]}")
            owned.add(key)
    for row in database.query("""
        SELECT c.category_key,q.level_key,SUM(CASE WHEN r.question_key IS NULL THEN 1 ELSE 0 END) count
        FROM questions q
        JOIN categories c ON c.bank_id=q.bank_id AND c.category_id=q.category_id
        LEFT JOIN question_retirements r ON r.question_key=q.question_key
        WHERE c.active=1 AND q.seed_status='active'
        GROUP BY c.category_key,q.level_key
    """):
        if row["count"] == 0:
            add(warnings, "STOCK_ZERO", f'{row["category_key"]}|{row["level_key"]}', "reposición necesaria")
        elif row["count"] <= LOW_STOCK_THRESHOLD:
            add(warnings, "STOCK_LOW", f'{row["category_key"]}|{row["level_key"]}', row["count"])
    retired = database.one("SELECT COUNT(*) count FROM question_retirements")["count"]
    if retired:
        add(warnings, "GLOBAL_RETIREMENTS", "questions", retired)
    if seed_status.get("error"):
        add(errors, "SEED_LOAD", "seed", seed_status["error"])
    meta = {row["key"]: row["value"] for row in database.query("SELECT * FROM runtime_meta")}
    if int(meta.get("schema_version", -1)) != SCHEMA_VERSION:
        add(errors, "SCHEMA_VERSION", "runtime_meta", meta.get("schema_version"))
    if meta.get("rules_version") != RULES_VERSION:
        add(errors, "RULES_VERSION", "runtime_meta", meta.get("rules_version"))
    if seed_status.get("seedVersion") and meta.get("seed_version") != seed_status["seedVersion"]:
        add(errors, "SEED_VERSION", "runtime_meta", f'{meta.get("seed_version")} != {seed_status["seedVersion"]}')
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "questionCount": actual,
            "activeQuestionCount": database.one("SELECT COUNT(*) count FROM questions q LEFT JOIN question_retirements r ON r.question_key=q.question_key WHERE q.seed_status='active' AND r.question_key IS NULL")["count"],
            "retiredGlobally": retired,
            "matchCount": len(match_ids),
            "eventCount": database.one("SELECT COUNT(*) count FROM events")["count"],
            "seedVersion": meta.get("seed_version"),
            "schemaVersion": SCHEMA_VERSION,
            "rulesVersion": RULES_VERSION,
            "revision": database.revision(),
        },
    }


def create_backup(database):
    with database.snapshot() as snapshot:
        return _create_backup(snapshot)


def _create_backup(database):
    meta = {row["key"]: row["value"] for row in database.query("SELECT * FROM runtime_meta")}
    matches = database.query("SELECT * FROM matches WHERE seed_owned=0 ORDER BY created_at,match_id")
    match_ids = [row["match_id"] for row in matches]
    if match_ids:
        placeholders = ",".join("?" for _ in match_ids)
        participants = database.query(f"SELECT * FROM participants WHERE match_id IN ({placeholders}) ORDER BY match_id,seat_no", match_ids)
        events = database.query(f"SELECT * FROM events WHERE match_id IN ({placeholders}) ORDER BY match_id,seq", match_ids)
    else:
        participants = []
        events = []
    return {
        "backupVersion": BACKUP_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "rulesVersion": RULES_VERSION,
        "seedVersion": meta.get("seed_version"),
        "seedDigest": meta.get("seed_digest"),
        "generatedAt": utc_now(),
        "matches": matches,
        "participants": participants,
        "events": events,
        "questionRetirements": database.query("SELECT * FROM question_retirements ORDER BY retired_at,question_key"),
    }


def validate_backup(database, payload):
    errors = []
    if not isinstance(payload, dict):
        return ["El backup debe ser un objeto JSON."]
    if payload.get("backupVersion") != BACKUP_VERSION:
        errors.append("backupVersion incompatible")
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("schemaVersion incompatible")
    current = {row["key"]: row["value"] for row in database.query("SELECT * FROM runtime_meta")}
    if payload.get("seedDigest") != current.get("seed_digest"):
        errors.append("La copia pertenece a otra versión de la semilla")
    tables = {name: payload.get(name) for name in ["matches", "participants", "events", "questionRetirements"]}
    if any(not isinstance(rows, list) for rows in tables.values()):
        errors.append("Faltan tablas del backup")
        return errors
    if any(not isinstance(row, dict) for rows in tables.values() for row in rows):
        errors.append("Todas las filas deben ser objetos")
        return errors
    required = {
        "matches": {"match_id", "name", "bank_id", "player_ids_json", "enabled_category_ids_json", "enabled_level_keys_json", "rules_version", "level_weights_json", "catalog_snapshot_json", "seed", "status", "created_at", "closed_at", "close_reason", "source", "seed_owned", "owner_session_id"},
        "participants": {"match_player_id", "match_id", "player_id", "player_name", "seat_no", "active", "seed_owned"},
        "events": {"event_id", "match_id", "seq", "timestamp", "type", "schema_version", "action_id", "idempotency_key", "payload_json", "seed_owned"},
        "questionRetirements": {"question_key", "retired_at", "reason", "note", "match_id", "event_id", "retired_by_session_id"},
    }
    for table, rows in tables.items():
        for index, row in enumerate(rows):
            missing = required[table] - row.keys()
            if missing:
                errors.append(f'{table}[{index}]: faltan {",".join(sorted(missing))}')
    if errors:
        return errors
    match_ids = [row.get("match_id") for row in tables["matches"]]
    if any(not isinstance(value, str) or not value for value in match_ids):
        errors.append("match_id vacío o inválido")
        return errors
    if len(match_ids) != len(set(match_ids)):
        errors.append("match_id vacío o duplicado")
    event_ids = [row.get("event_id") for row in tables["events"]]
    if any(not isinstance(value, str) or not value for value in event_ids):
        errors.append("event_id vacío o inválido")
        return errors
    if len(event_ids) != len(set(event_ids)):
        errors.append("event_id vacío o duplicado")
    if any(not isinstance(row.get("match_id"), str) or not isinstance(row.get("seq"), int) for row in tables["events"]):
        errors.append("match_id o seq de evento inválido")
        return errors
    seqs = [(row.get("match_id"), row.get("seq")) for row in tables["events"]]
    if len(seqs) != len(set(seqs)):
        errors.append("seq duplicada")
    idem = [row.get("idempotency_key") for row in tables["events"] if row.get("idempotency_key")]
    if any(not isinstance(value, str) for value in idem):
        errors.append("idempotency_key inválida")
        return errors
    if len(idem) != len(set(idem)):
        errors.append("idempotency_key duplicada")
    known_matches = set(match_ids)
    if any(row.get("match_id") not in known_matches for row in tables["participants"] + tables["events"]):
        errors.append("FK de partida inválida")
    seed_matches = {row["match_id"] for row in database.query("SELECT match_id FROM matches WHERE seed_owned=1")}
    if known_matches & seed_matches:
        errors.append("match_id reservado por la semilla")
    seed_idempotency = {row["idempotency_key"] for row in database.query("SELECT idempotency_key FROM events WHERE seed_owned=1 AND idempotency_key IS NOT NULL")}
    if set(idem) & seed_idempotency:
        errors.append("idempotency_key reservada por la semilla")
    bank_ids = {row["bank_id"] for row in database.query("SELECT bank_id FROM banks")}
    player_ids = {row["player_id"] for row in database.query("SELECT player_id FROM players")}
    category_keys = {row["category_key"] for row in database.query("SELECT category_key FROM categories")}
    level_keys = {row["level_key"] for row in database.query("SELECT level_key FROM levels")}
    match_players = {}

    def valid_id_list(values, minimum=1, maximum=None):
        return isinstance(values, list) and len(values) >= minimum and (maximum is None or len(values) <= maximum) and all(isinstance(value, str) and value for value in values) and len(values) == len(set(values))

    for row in tables["matches"]:
        try:
            players = json.loads(row["player_ids_json"])
            categories = json.loads(row["enabled_category_ids_json"])
            levels = json.loads(row["enabled_level_keys_json"])
            weights = json.loads(row["level_weights_json"])
            snapshot = json.loads(row["catalog_snapshot_json"])
        except (TypeError, json.JSONDecodeError):
            errors.append(f'catálogo de partida inválido: {row.get("match_id")}')
            continue
        if row["source"] != "web" or not isinstance(row["bank_id"], str) or row["bank_id"] not in bank_ids or not isinstance(row["status"], str) or row["status"] not in {"open", "closed"}:
            errors.append(f'partida inválida: {row["match_id"]}')
        if not valid_id_list(players, maximum=3) or any(player not in player_ids for player in players):
            errors.append(f'jugadores inválidos: {row["match_id"]}')
        if not valid_id_list(categories) or any(f'{row["bank_id"]}|{category}' not in category_keys for category in categories):
            errors.append(f'categorías inválidas: {row["match_id"]}')
        if not valid_id_list(levels) or any(level not in level_keys for level in levels):
            errors.append(f'niveles inválidos: {row["match_id"]}')
        if not isinstance(weights, dict) or not isinstance(snapshot, dict):
            errors.append(f'pesos o snapshot inválidos: {row["match_id"]}')
        match_players[row["match_id"]] = set(players) if valid_id_list(players, maximum=3) else set()
    participant_ids = [row["match_player_id"] for row in tables["participants"]]
    participant_pairs = [(row["match_id"], row["player_id"]) for row in tables["participants"]]
    if any(not isinstance(value, str) or not value for value in participant_ids) or any(not isinstance(match_id, str) or not isinstance(player_id, str) for match_id, player_id in participant_pairs):
        errors.append("participante inválido")
        return errors
    if len(participant_ids) != len(set(participant_ids)) or len(participant_pairs) != len(set(participant_pairs)):
        errors.append("participante duplicado")
    if any(row["player_id"] not in match_players.get(row["match_id"], set()) or not isinstance(row["seat_no"], int) or row["seat_no"] < 1 for row in tables["participants"]):
        errors.append("participante inválido")
    parsed_events = {}
    for row in tables["events"]:
        try:
            event_payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            errors.append(f'payload inválido: {row.get("event_id")}')
            continue
        if not isinstance(event_payload, dict) or not isinstance(row["type"], str) or row["type"] not in EVENT_TYPES or row["schema_version"] != EVENT_SCHEMA_VERSION or not isinstance(row["seq"], int) or row["seq"] < 1:
            errors.append(f'evento inválido: {row["event_id"]}')
        parsed_events[row["event_id"]] = (row, event_payload)
    for event_id, (row, event_payload) in parsed_events.items():
        if row["type"] in {"ANSWER_REVEALED", "RESULT_RECORDED", "QUESTION_DISCARDED"}:
            draw_id = event_payload.get("drawEventId")
            draw = parsed_events.get(draw_id) if isinstance(draw_id, str) else None
            if not draw or draw[0]["type"] != "QUESTION_DRAWN" or draw[0]["match_id"] != row["match_id"]:
                errors.append(f'referencia a sorteo inválida: {event_id}')
        if row["type"] in {"EVENT_REVERTED", "EVENT_RESTORED"}:
            targets = event_payload.get("targetEventIds")
            if not isinstance(targets, list) or not all(isinstance(target, str) for target in targets) or any(target not in parsed_events or parsed_events[target][0]["match_id"] != row["match_id"] for target in targets):
                errors.append(f'referencia undo/redo inválida: {event_id}')
    for row in tables["matches"]:
        rows = sorted([event for event, _ in parsed_events.values() if event["match_id"] == row["match_id"]], key=lambda event: event["seq"])
        if [event["seq"] for event in rows] != list(range(1, len(rows) + 1)) or not rows or rows[0]["type"] != "MATCH_CREATED":
            errors.append(f'ledger incompleto: {row["match_id"]}')
            continue
        events = [{"eventId": event["event_id"], "matchId": event["match_id"], "seq": event["seq"], "timestamp": event["timestamp"], "type": event["type"], "schemaVersion": event["schema_version"], "actionId": event["action_id"], "idempotencyKey": event["idempotency_key"], "payload": parsed_events[event["event_id"]][1]} for event in rows]
        state = derive_state({"source": "web", "status": row["status"]}, events)
        if state["status"] != row["status"]:
            errors.append(f'proyección de partida incoherente: {row["match_id"]}')
    question_keys = {row["question_key"] for row in database.query("SELECT question_key FROM questions")}
    retirement_keys = [row.get("question_key") for row in tables["questionRetirements"]]
    if any(not isinstance(key, str) for key in retirement_keys) or len(retirement_keys) != len(set(retirement_keys)) or any(key not in question_keys for key in retirement_keys):
        errors.append("Retirada de pregunta inválida")
    if any(not isinstance(row["match_id"], str) or not isinstance(row["event_id"], str) or row["match_id"] not in known_matches or row["event_id"] not in parsed_events or parsed_events[row["event_id"]][0]["type"] != "QUESTION_DISCARDED" for row in tables["questionRetirements"]):
        errors.append("FK de retirada inválida")
    return errors


def restore_backup(database, payload, owner_session_id):
    with database.transaction() as connection:
        errors = validate_backup(ConnectionView(connection), payload)
        if errors:
            raise ValueError("; ".join(errors[:8]))
        connection.execute("DELETE FROM api_requests")
        connection.execute("DELETE FROM events WHERE seed_owned=0")
        connection.execute("DELETE FROM participants WHERE seed_owned=0")
        connection.execute("DELETE FROM matches WHERE seed_owned=0")
        connection.execute("DELETE FROM question_retirements")
        for row in payload["matches"]:
            values = dict(row)
            values["owner_session_id"] = owner_session_id
            values["seed_owned"] = 0
            connection.execute(
                "INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                tuple(values[key] for key in ["match_id", "name", "bank_id", "player_ids_json", "enabled_category_ids_json", "enabled_level_keys_json", "rules_version", "level_weights_json", "catalog_snapshot_json", "seed", "status", "created_at", "closed_at", "close_reason", "source", "seed_owned", "owner_session_id"]),
            )
        for row in payload["participants"]:
            connection.execute("INSERT INTO participants VALUES(?,?,?,?,?,?,0)", tuple(row[key] for key in ["match_player_id", "match_id", "player_id", "player_name", "seat_no", "active"]))
        for row in payload["events"]:
            connection.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,0)", tuple(row[key] for key in ["event_id", "match_id", "seq", "timestamp", "type", "schema_version", "action_id", "idempotency_key", "payload_json"]))
        for row in payload["questionRetirements"]:
            values = [row[key] for key in ["question_key", "retired_at", "reason", "note", "match_id", "event_id"]]
            connection.execute("INSERT INTO question_retirements VALUES(?,?,?,?,?,?,?)", (*values, owner_session_id))
        database.bump_revision(connection)


def reset_to_seed(database):
    with database.transaction() as connection:
        connection.execute("DELETE FROM api_requests")
        connection.execute("DELETE FROM events WHERE seed_owned=0")
        connection.execute("DELETE FROM participants WHERE seed_owned=0")
        connection.execute("DELETE FROM matches WHERE seed_owned=0")
        connection.execute("DELETE FROM question_retirements")
        database.bump_revision(connection)
