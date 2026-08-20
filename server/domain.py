import hashlib
import json
import secrets
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from .config import EVENT_SCHEMA_VERSION, EVENT_TYPES, RULES_VERSION
from .storage import compact_json, utc_now


class GameError(ValueError):
    def __init__(self, message, code="INVALID_ACTION", status=400):
        super().__init__(message)
        self.code = code
        self.status = status


def deterministic_unit(seed, ordinal, player_id, category_id):
    material = f"{seed}|{ordinal}|{player_id}|{category_id}".encode()
    integer = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
    return integer / 2**64


def active_events(events):
    reverted = set()
    for event in events:
        payload = event["payload"]
        if event["type"] == "EVENT_REVERTED":
            reverted.update(payload.get("targetEventIds", []))
        elif event["type"] == "EVENT_RESTORED":
            reverted.difference_update(payload.get("targetEventIds", []))
    return [event for event in events if event["type"] not in {"EVENT_REVERTED", "EVENT_RESTORED"} and event["eventId"] not in reverted]


def reverted_ids(events):
    reverted = set()
    for event in events:
        if event["type"] == "EVENT_REVERTED":
            reverted.update(event["payload"].get("targetEventIds", []))
        elif event["type"] == "EVENT_RESTORED":
            reverted.difference_update(event["payload"].get("targetEventIds", []))
    return reverted


def derive_state(match, events):
    state = {
        "status": "open" if match["source"] == "web" else match["status"],
        "currentTurnPlayerId": None,
        "currentDraw": None,
        "answerRevealed": False,
        "close": None,
    }
    for event in active_events(events):
        payload = event["payload"]
        event_type = event["type"]
        if event_type == "TURN_SELECTED":
            state["currentTurnPlayerId"] = payload["playerId"]
        elif event_type == "QUESTION_DRAWN":
            state["currentTurnPlayerId"] = payload["playerId"]
            state["currentDraw"] = {
                "eventId": event["eventId"],
                "playerId": payload["playerId"],
                "categoryId": payload["categoryId"],
                "levelKey": payload["levelKey"],
                "questionKey": payload["questionKey"],
                "quesitoAttempt": bool(payload["quesitoAttempt"]),
                "drawOrdinal": int(payload["drawOrdinal"]),
                "randomUnit": payload["randomUnit"],
                "effectiveWeights": payload["effectiveWeights"],
                "replacementForEventId": payload.get("replacementForEventId"),
                "question": payload.get("question", {}),
            }
            state["answerRevealed"] = False
        elif event_type == "ANSWER_REVEALED" and state["currentDraw"] and state["currentDraw"]["eventId"] == payload.get("drawEventId"):
            state["answerRevealed"] = True
        elif event_type == "RESULT_RECORDED" and state["currentDraw"] and state["currentDraw"]["eventId"] == payload.get("drawEventId"):
            state["currentDraw"] = None
            state["currentTurnPlayerId"] = None
            state["answerRevealed"] = False
        elif event_type == "QUESTION_DISCARDED" and state["currentDraw"] and state["currentDraw"]["eventId"] == payload.get("drawEventId"):
            state["currentDraw"] = None
            state["answerRevealed"] = False
        elif event_type == "MATCH_CLOSED":
            state["status"] = "closed"
            state["close"] = payload
            state["currentTurnPlayerId"] = None
    return state


def quesitos(events, historical_attempts=()):
    owned = defaultdict(set)
    for attempt in historical_attempts:
        if attempt.get("active") and attempt.get("quesitoWon"):
            owned[attempt["playerId"]].add(attempt["categoryId"])
    for event in active_events(events):
        if event["type"] == "RESULT_RECORDED" and event["payload"].get("quesitoWon"):
            owned[event["payload"]["playerId"]].add(event["payload"]["categoryId"])
    return owned


def _parse_event(row):
    return {
        "eventId": row["event_id"],
        "matchId": row["match_id"],
        "seq": row["seq"],
        "timestamp": row["timestamp"],
        "type": row["type"],
        "schemaVersion": row["schema_version"],
        "actionId": row["action_id"],
        "idempotencyKey": row["idempotency_key"],
        "payload": json.loads(row["payload_json"]),
    }


def _parse_match(row):
    return {
        "matchId": row["match_id"],
        "name": row["name"],
        "bankId": row["bank_id"],
        "playerIds": json.loads(row["player_ids_json"]),
        "enabledCategoryIds": json.loads(row["enabled_category_ids_json"]),
        "enabledLevelKeys": json.loads(row["enabled_level_keys_json"]),
        "rulesVersion": row["rules_version"],
        "levelWeights": json.loads(row["level_weights_json"]),
        "catalogSnapshot": json.loads(row["catalog_snapshot_json"]),
        "seed": row["seed"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "closedAt": row["closed_at"],
        "closeReason": row["close_reason"],
        "source": row["source"],
        "ownerSessionId": row["owner_session_id"],
    }


class GameService:
    def __init__(self, database):
        self.database = database

    def _match(self, connection, match_id):
        row = connection.execute("SELECT * FROM matches WHERE match_id=?", (match_id,)).fetchone()
        if not row:
            raise GameError("Partida no encontrada.", "MATCH_NOT_FOUND", 404)
        return _parse_match(dict(row))

    def reconcile_all(self):
        changed = False
        with self.database.transaction() as connection:
            rows = connection.execute("SELECT * FROM matches WHERE source='web'").fetchall()
            for row in rows:
                match = _parse_match(dict(row))
                events = self._events(connection, match["matchId"])
                state = derive_state(match, events)
                close_event = next((event for event in reversed(active_events(events)) if event["type"] == "MATCH_CLOSED"), None)
                desired_status = state["status"]
                desired_closed_at = close_event["timestamp"] if close_event else None
                desired_reason = state["close"].get("reason") if state["close"] else None
                if (match["status"], match["closedAt"], match["closeReason"]) != (desired_status, desired_closed_at, desired_reason):
                    connection.execute("UPDATE matches SET status=?,closed_at=?,close_reason=? WHERE match_id=?", (desired_status, desired_closed_at, desired_reason, match["matchId"]))
                    changed = True
            if changed:
                self.database.bump_revision(connection)
        return changed

    def _events(self, connection, match_id):
        return [_parse_event(dict(row)) for row in connection.execute("SELECT * FROM events WHERE match_id=? ORDER BY seq,event_id", (match_id,)).fetchall()]

    def _authorize(self, match, session_id):
        if match["source"] != "web" or not match["ownerSessionId"]:
            raise GameError("La partida histórica es de solo lectura.", "READ_ONLY", 403)
        if match["ownerSessionId"] != session_id:
            raise GameError("Esta sesión no puede modificar la partida.", "FORBIDDEN", 403)

    def _append(self, connection, match_id, events, event_type, action_id, payload, idempotency_key=None):
        if event_type not in EVENT_TYPES:
            raise GameError(f"Evento no admitido: {event_type}")
        seq = max([event["seq"] for event in events], default=0) + 1
        event = {
            "eventId": f"E-{uuid.uuid4()}",
            "matchId": match_id,
            "seq": seq,
            "timestamp": utc_now(),
            "type": event_type,
            "schemaVersion": EVENT_SCHEMA_VERSION,
            "actionId": action_id,
            "idempotencyKey": idempotency_key,
            "payload": payload,
        }
        connection.execute(
            "INSERT INTO events(event_id,match_id,seq,timestamp,type,schema_version,action_id,idempotency_key,payload_json,seed_owned) VALUES(?,?,?,?,?,?,?,?,?,0)",
            (event["eventId"], match_id, seq, event["timestamp"], event_type, EVENT_SCHEMA_VERSION, action_id, idempotency_key, compact_json(payload)),
        )
        events.append(event)
        return event

    def _available(self, connection, match, events, category_id, level_key=None):
        seen = {event["payload"].get("questionKey") for event in events if event["type"] == "QUESTION_DRAWN"}
        sql = """
            SELECT q.* FROM questions q
            LEFT JOIN question_retirements r ON r.question_key=q.question_key
            WHERE q.bank_id=? AND q.category_id=? AND q.seed_status='active' AND r.question_key IS NULL
        """
        parameters = [match["bankId"], category_id]
        if level_key:
            sql += " AND q.level_key=?"
            parameters.append(level_key)
        else:
            placeholders = ",".join("?" for _ in match["enabledLevelKeys"])
            sql += f" AND q.level_key IN ({placeholders})"
            parameters.extend(match["enabledLevelKeys"])
        sql += " ORDER BY q.order_key,q.question_key"
        return [dict(row) for row in connection.execute(sql, parameters).fetchall() if row["question_key"] not in seen]

    def _draw_ordinal(self, events):
        return sum(1 for event in events if event["type"] == "QUESTION_DRAWN") + 1

    def _select_question(self, connection, match, events, player_id, category_id, ordinal, preferred_level=None):
        if preferred_level:
            same_level = self._available(connection, match, events, category_id, preferred_level)
            if same_level:
                unit = deterministic_unit(match["seed"], ordinal, player_id, category_id)
                weight = float(match["levelWeights"][category_id].get(preferred_level, 0))
                return same_level[0], unit, {preferred_level: weight}, "same_level_replacement"
        available = self._available(connection, match, events, category_id)
        by_level = defaultdict(list)
        for question in available:
            by_level[question["level_key"]].append(question)
        weighted = []
        for level_key in match["enabledLevelKeys"]:
            if by_level[level_key]:
                weighted.append((level_key, max(0.0, float(match["levelWeights"][category_id].get(level_key, 0)))))
        if not weighted:
            return None
        if sum(weight for _, weight in weighted) <= 0:
            weighted = [(level_key, 1.0) for level_key, _ in weighted]
        unit = deterministic_unit(match["seed"], ordinal, player_id, category_id)
        cursor = unit * sum(weight for _, weight in weighted)
        selected_level = weighted[-1][0]
        for level_key, weight in weighted:
            if cursor < weight:
                selected_level = level_key
                break
            cursor -= weight
        return by_level[selected_level][0], unit, dict(weighted), "weighted"

    def _question_payload(self, question):
        return {
            "prompt": question["prompt"],
            "answer": question["answer"],
            "explanation": question["explanation"],
            "categoryId": question["category_id"],
            "levelKey": question["level_key"],
        }

    def _draw_event(self, connection, match, events, player_id, category_id, quesito_attempt, action_id, replacement_for=None, preferred_level=None):
        ordinal = self._draw_ordinal(events)
        selected = self._select_question(connection, match, events, player_id, category_id, ordinal, preferred_level)
        if not selected:
            return None
        question, unit, weights, reason = selected
        return self._append(connection, match["matchId"], events, "QUESTION_DRAWN", action_id, {
            "drawOrdinal": ordinal,
            "randomUnit": unit,
            "effectiveWeights": weights,
            "playerId": player_id,
            "categoryId": category_id,
            "levelKey": question["level_key"],
            "questionKey": question["question_key"],
            "quesitoAttempt": bool(quesito_attempt),
            "replacementForEventId": replacement_for,
            "selectionReason": reason,
            "question": self._question_payload(question),
        })

    def create_match(self, session_id, payload, request_id):
        if not session_id:
            raise GameError("Sesión no disponible.", "SESSION_REQUIRED", 401)
        request_id = request_scope(session_id, "matches", request_id)
        with self.database.transaction() as connection:
            cached = connection.execute("SELECT response_json FROM api_requests WHERE request_id=?", (request_id,)).fetchone()
            if cached:
                return json.loads(cached[0])
            bank_id = str(payload.get("bankId", ""))
            player_ids = list(dict.fromkeys(payload.get("playerIds") or []))
            category_ids = list(dict.fromkeys(payload.get("categoryIds") or []))
            level_keys = list(dict.fromkeys(payload.get("levelKeys") or []))
            if not connection.execute("SELECT 1 FROM banks WHERE bank_id=?", (bank_id,)).fetchone():
                raise GameError("Selecciona un banco válido.")
            if not 1 <= len(player_ids) <= 3:
                raise GameError("Selecciona entre uno y tres jugadores.")
            players = [dict(row) for row in connection.execute(f"SELECT * FROM players WHERE active=1 AND player_id IN ({','.join('?' for _ in player_ids)})", player_ids).fetchall()]
            if len(players) != len(player_ids):
                raise GameError("La selección de jugadores no es válida.")
            categories = [dict(row) for row in connection.execute(f"SELECT * FROM categories WHERE bank_id=? AND active=1 AND category_id IN ({','.join('?' for _ in category_ids)})", [bank_id, *category_ids]).fetchall()] if category_ids else []
            if not category_ids or len(categories) != len(category_ids):
                raise GameError("Selecciona al menos una categoría válida.")
            levels = [dict(row) for row in connection.execute(f"SELECT * FROM levels WHERE level_key IN ({','.join('?' for _ in level_keys)})", level_keys).fetchall()] if level_keys else []
            if not level_keys or len(levels) != len(level_keys):
                raise GameError("Selecciona al menos un nivel válido.")
            for category_id in category_ids:
                placeholders = ",".join("?" for _ in level_keys)
                stock = connection.execute(f"SELECT COUNT(*) FROM questions q LEFT JOIN question_retirements r ON r.question_key=q.question_key WHERE q.bank_id=? AND q.category_id=? AND q.level_key IN ({placeholders}) AND q.seed_status='active' AND r.question_key IS NULL", [bank_id, category_id, *level_keys]).fetchone()[0]
                if not stock:
                    raise GameError(f"No hay stock para la categoría {category_id}.", "NO_STOCK")
            player_map = {row["player_id"]: row for row in players}
            category_map = {row["category_id"]: row for row in categories}
            level_map = {row["level_key"]: row for row in levels}
            level_weights = {category_id: {level_key: level_map[level_key]["probability_weight"] for level_key in level_keys} for category_id in category_ids}
            snapshot = {
                "players": [{"playerId": player_id, "name": player_map[player_id]["name"]} for player_id in player_ids],
                "categories": [{"categoryId": category_id, "label": category_map[category_id]["label"], "color": category_map[category_id]["color"], "emoji": category_map[category_id]["emoji"]} for category_id in category_ids],
                "levels": [{"levelKey": level_key, "label": level_map[level_key]["label"]} for level_key in level_keys],
            }
            match_id = f"M{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(5)}"
            created_at = utc_now()
            match_seed = secrets.token_hex(16)
            name = str(payload.get("name") or "").strip()[:120] or f"Partida {datetime.now().strftime('%d/%m/%Y')}"
            connection.execute(
                "INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (match_id, name, bank_id, compact_json(player_ids), compact_json(category_ids), compact_json(level_keys), RULES_VERSION, compact_json(level_weights), compact_json(snapshot), match_seed, "open", created_at, None, None, "web", 0, session_id),
            )
            for seat_no, player_id in enumerate(player_ids, 1):
                connection.execute("INSERT INTO participants VALUES(?,?,?,?,?,?,0)", (f"{match_id}|{player_id}", match_id, player_id, player_map[player_id]["name"], seat_no, 1))
            match = self._match(connection, match_id)
            events = []
            self._append(connection, match_id, events, "MATCH_CREATED", request_id, {
                "matchId": match_id,
                "bankId": bank_id,
                "playerIds": player_ids,
                "enabledCategoryIds": category_ids,
                "enabledLevelKeys": level_keys,
                "rulesVersion": RULES_VERSION,
                "seed": match_seed,
                "levelWeights": level_weights,
                "createdAt": created_at,
            }, f"{match_id}:created")
            self.database.bump_revision(connection)
            response = self._detail(connection, match, events, session_id)
            connection.execute("INSERT INTO api_requests VALUES(?,?,?)", (request_id, compact_json(response), utc_now()))
            return response

    def perform_action(self, match_id, session_id, payload, request_id):
        request_id = request_scope(session_id, match_id, request_id)
        action = payload.get("action")
        with self.database.transaction() as connection:
            cached = connection.execute("SELECT response_json FROM api_requests WHERE request_id=?", (request_id,)).fetchone()
            if cached:
                return json.loads(cached[0])
            match = self._match(connection, match_id)
            self._authorize(match, session_id)
            events = self._events(connection, match_id)
            state = derive_state(match, events)
            action_id = request_id
            if action == "select_turn":
                self._select_turn(connection, match, events, state, payload, action_id)
            elif action == "draw":
                self._draw(connection, match, events, state, payload, action_id)
            elif action == "reveal":
                self._reveal(connection, match, events, state, action_id)
            elif action == "result":
                self._result(connection, match, events, state, payload, action_id)
            elif action == "discard":
                self._discard(connection, match, events, state, payload, action_id, session_id)
            elif action == "undo":
                self._undo(connection, match, events, state, action_id)
            elif action == "redo":
                self._redo(connection, match, events, state, action_id)
            elif action == "close":
                self._close(connection, match, events, state, payload, action_id)
            else:
                raise GameError("Acción desconocida.")
            self._reconcile_match(connection, match, events)
            self.database.bump_revision(connection)
            match = self._match(connection, match_id)
            response = self._detail(connection, match, events, session_id)
            connection.execute("INSERT INTO api_requests VALUES(?,?,?)", (request_id, compact_json(response), utc_now()))
            return response

    def _ensure_open(self, state):
        if state["status"] != "open":
            raise GameError("La partida está cerrada.", "MATCH_CLOSED")

    def _select_turn(self, connection, match, events, state, payload, action_id):
        self._ensure_open(state)
        if state["currentDraw"]:
            raise GameError("Hay una pregunta pendiente.", "PENDING_QUESTION")
        player_id = payload.get("playerId")
        if player_id not in match["playerIds"]:
            raise GameError("Selecciona un jugador válido.")
        self._append(connection, match["matchId"], events, "TURN_SELECTED", action_id, {"playerId": player_id}, f"{match['matchId']}:turn:{request_hash(action_id)}")

    def _draw(self, connection, match, events, state, payload, action_id):
        self._ensure_open(state)
        if state["currentDraw"]:
            raise GameError("Ya hay una pregunta pendiente.", "PENDING_QUESTION")
        player_id = state["currentTurnPlayerId"]
        if player_id not in match["playerIds"]:
            raise GameError("Elige primero el jugador del turno.", "TURN_REQUIRED")
        category_id = payload.get("categoryId")
        if category_id not in match["enabledCategoryIds"]:
            raise GameError("Selecciona una categoría válida.")
        attempt = bool(payload.get("quesitoAttempt"))
        if attempt and category_id in quesitos(events).get(player_id, set()):
            raise GameError("Ese jugador ya posee el quesito.", "DUPLICATE_QUESITO")
        if not self._draw_event(connection, match, events, player_id, category_id, attempt, action_id):
            raise GameError("No queda stock para esa categoría y niveles.", "NO_STOCK")

    def _reveal(self, connection, match, events, state, action_id):
        self._ensure_open(state)
        draw = state["currentDraw"]
        if not draw:
            raise GameError("No hay una pregunta pendiente.")
        if state["answerRevealed"]:
            return
        self._append(connection, match["matchId"], events, "ANSWER_REVEALED", action_id, {"drawEventId": draw["eventId"], "questionKey": draw["questionKey"]}, f"{match['matchId']}:reveal:{draw['eventId']}")

    def _result(self, connection, match, events, state, payload, action_id):
        self._ensure_open(state)
        draw = state["currentDraw"]
        if not draw or not state["answerRevealed"]:
            raise GameError("Muestra primero la respuesta de la pregunta pendiente.")
        player_id = payload.get("playerId")
        if player_id not in match["playerIds"]:
            raise GameError("Indica qué jugador respondió.")
        correct = payload.get("correct")
        if not isinstance(correct, bool):
            raise GameError("El resultado debe ser acierto o fallo.")
        owned = quesitos(events)
        quesito_won = bool(correct and draw["quesitoAttempt"] and draw["categoryId"] not in owned.get(player_id, set()))
        self._append(connection, match["matchId"], events, "RESULT_RECORDED", action_id, {
            "drawEventId": draw["eventId"],
            "questionKey": draw["questionKey"],
            "turnPlayerId": draw["playerId"],
            "playerId": player_id,
            "categoryId": draw["categoryId"],
            "levelKey": draw["levelKey"],
            "correct": correct,
            "quesitoAttempt": draw["quesitoAttempt"],
            "quesitoWon": quesito_won,
        }, f"{match['matchId']}:terminal:{draw['eventId']}")
        won = set(owned.get(player_id, set()))
        if quesito_won:
            won.add(draw["categoryId"])
        if all(category_id in won for category_id in match["enabledCategoryIds"]):
            self._append(connection, match["matchId"], events, "MATCH_CLOSED", action_id, {"reason": "victoria", "winners": [player_id]})

    def _discard(self, connection, match, events, state, payload, action_id, session_id):
        self._ensure_open(state)
        draw = state["currentDraw"]
        if not draw:
            raise GameError("No hay una pregunta pendiente.")
        reason = str(payload.get("reason") or "").strip()
        allowed = {"ambigua", "incorrecta", "desactualizada", "comprometida", "duplicada", "otro"}
        if reason not in allowed:
            raise GameError("Indica un motivo de descarte válido.")
        note = str(payload.get("note") or "").strip()[:500]
        event = self._append(connection, match["matchId"], events, "QUESTION_DISCARDED", action_id, {
            "drawEventId": draw["eventId"],
            "questionKey": draw["questionKey"],
            "playerId": draw["playerId"],
            "categoryId": draw["categoryId"],
            "levelKey": draw["levelKey"],
            "quesitoAttempt": draw["quesitoAttempt"],
            "reason": reason,
            "note": note,
            "retiredGlobally": True,
        }, f"{match['matchId']}:terminal:{draw['eventId']}")
        connection.execute(
            "INSERT OR IGNORE INTO question_retirements VALUES(?,?,?,?,?,?,?)",
            (draw["questionKey"], utc_now(), reason, note, match["matchId"], event["eventId"], session_id),
        )
        self._draw_event(connection, match, events, draw["playerId"], draw["categoryId"], draw["quesitoAttempt"], action_id, draw["eventId"], draw["levelKey"])

    def _undo(self, connection, match, events, state, action_id):
        if state["currentDraw"] and not state["currentDraw"].get("replacementForEventId"):
            raise GameError("Resuelve o rehace la pregunta pendiente antes de deshacer otra acción.")
        active = active_events(events)
        candidate = None
        for event in reversed(active):
            if event["type"] in {"RESULT_RECORDED", "QUESTION_DISCARDED", "MATCH_CLOSED"}:
                candidate = event
                break
        if not candidate:
            raise GameError("No hay ninguna acción que deshacer.", "NOTHING_TO_UNDO")
        targets = [event["eventId"] for event in active if event["actionId"] == candidate["actionId"] and event["type"] in {"RESULT_RECORDED", "QUESTION_DISCARDED", "QUESTION_DRAWN", "MATCH_CLOSED"}]
        self._append(connection, match["matchId"], events, "EVENT_REVERTED", action_id, {"targetEventIds": targets, "label": candidate["type"]})

    def _redo(self, connection, match, events, state, action_id):
        reverted = reverted_ids(events)
        target = None
        for event in reversed(events):
            if event["type"] == "EVENT_REVERTED":
                ids = event["payload"].get("targetEventIds", [])
                if any(event_id in reverted for event_id in ids):
                    target = ids
                    break
        if not target:
            raise GameError("No hay ninguna acción que rehacer.", "NOTHING_TO_REDO")
        self._append(connection, match["matchId"], events, "EVENT_RESTORED", action_id, {"targetEventIds": target})

    def _close(self, connection, match, events, state, payload, action_id):
        self._ensure_open(state)
        if state["currentDraw"]:
            raise GameError("Resuelve o descarta la pregunta pendiente antes de cerrar.")
        reason = payload.get("reason")
        if reason not in {"manual", "time_limit", "interruption", "other"}:
            raise GameError("Motivo de cierre inválido.")
        owned = quesitos(events)
        scores = {player_id: len(owned.get(player_id, set())) for player_id in match["playerIds"]}
        maximum = max(scores.values(), default=0)
        winners = [player_id for player_id, score in scores.items() if score == maximum]
        self._append(connection, match["matchId"], events, "MATCH_CLOSED", action_id, {"reason": reason, "winners": winners})

    def _reconcile_match(self, connection, match, events):
        state = derive_state(match, events)
        if state["status"] == "closed":
            close = state["close"] or {}
            closed_event = next((event for event in reversed(active_events(events)) if event["type"] == "MATCH_CLOSED"), None)
            connection.execute("UPDATE matches SET status='closed',closed_at=?,close_reason=? WHERE match_id=?", (closed_event["timestamp"] if closed_event else match["closedAt"], close.get("reason") or match["closeReason"], match["matchId"]))
        else:
            connection.execute("UPDATE matches SET status='open',closed_at=NULL,close_reason=NULL WHERE match_id=?", (match["matchId"],))

    def _undo_redo(self, events, state):
        active = active_events(events)
        pending_allows_undo = not state["currentDraw"] or bool(state["currentDraw"].get("replacementForEventId"))
        can_undo = pending_allows_undo and any(event["type"] in {"RESULT_RECORDED", "QUESTION_DISCARDED", "MATCH_CLOSED"} for event in active)
        reverted = reverted_ids(events)
        can_redo = any(event["type"] == "EVENT_REVERTED" and any(target in reverted for target in event["payload"].get("targetEventIds", [])) for event in events)
        return can_undo, can_redo

    def _stock(self, connection, match, events):
        rows = []
        for category_id in match["enabledCategoryIds"]:
            for level_key in match["enabledLevelKeys"]:
                rows.append({"categoryId": category_id, "levelKey": level_key, "count": len(self._available(connection, match, events, category_id, level_key))})
        return rows

    def _detail(self, connection, match, events, session_id):
        state = derive_state(match, events)
        historical = []
        if match["source"] != "web":
            historical = [{"playerId": row["player_id"], "categoryId": row["category_id"], "correct": None if row["correct"] is None else bool(row["correct"]), "computable": bool(row["computable"]), "quesitoWon": bool(row["quesito_won"]), "active": bool(row["active"])} for row in connection.execute("SELECT * FROM historical_attempts WHERE match_id=?", (match["matchId"],)).fetchall()]
        owned = quesitos(events, historical)
        active_results = [event for event in active_events(events) if event["type"] == "RESULT_RECORDED"]
        marker = []
        for player in match["catalogSnapshot"]["players"]:
            results = [event for event in active_results if event["payload"]["playerId"] == player["playerId"]]
            historical_results = [attempt for attempt in historical if attempt["playerId"] == player["playerId"] and attempt["active"] and attempt["computable"] and isinstance(attempt["correct"], bool)]
            marker.append({
                "playerId": player["playerId"],
                "name": player["name"],
                "correct": sum(1 for event in results if event["payload"]["correct"]) + sum(1 for attempt in historical_results if attempt["correct"]),
                "wrong": sum(1 for event in results if not event["payload"]["correct"]) + sum(1 for attempt in historical_results if not attempt["correct"]),
                "quesitos": sorted(owned.get(player["playerId"], set())),
            })
        draw = state["currentDraw"]
        if draw:
            frozen = draw.pop("question", {})
            draw["prompt"] = frozen.get("prompt")
            if state["answerRevealed"]:
                draw["answer"] = frozen.get("answer")
                draw["explanation"] = frozen.get("explanation")
        can_undo, can_redo = self._undo_redo(events, state)
        public_match = {key: value for key, value in match.items() if key not in {"ownerSessionId"}}
        return {
            "match": public_match,
            "writable": match["ownerSessionId"] == session_id and match["source"] == "web",
            "state": state,
            "marker": marker,
            "stock": self._stock(connection, match, events),
            "canUndo": can_undo,
            "canRedo": can_redo,
            "revision": int(connection.execute("SELECT value FROM runtime_meta WHERE key='state_revision'").fetchone()[0]),
        }

    def detail(self, match_id, session_id):
        connection = self.database.connect()
        try:
            connection.execute("BEGIN")
            match = self._match(connection, match_id)
            return self._detail(connection, match, self._events(connection, match_id), session_id)
        finally:
            connection.rollback()
            connection.close()

    def list_matches(self, session_id, database=None):
        rows = (database or self.database).query("SELECT * FROM matches ORDER BY created_at DESC,match_id DESC")
        result = []
        for row in rows:
            match = _parse_match(row)
            result.append({
                "matchId": match["matchId"],
                "name": match["name"],
                "playerIds": match["playerIds"],
                "players": match["catalogSnapshot"]["players"],
                "status": match["status"],
                "createdAt": match["createdAt"],
                "source": match["source"],
                "writable": match["ownerSessionId"] == session_id and match["source"] == "web",
            })
        return result


def request_hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:20]


def request_scope(session_id, resource, request_id):
    return hashlib.sha256(f"{session_id}|{resource}|{request_id}".encode()).hexdigest()
