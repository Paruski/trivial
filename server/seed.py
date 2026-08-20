import csv
import hashlib
import io
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .config import RULES_VERSION, SCHEMA_VERSION


REQUIRED = {
    "banks": ["bank_id", "name", "seed_version", "question_count", "level_weights_policy"],
    "categories": ["bank_id", "category_id", "category_key", "label", "color", "emoji", "active", "quesito_default"],
    "levels": ["level_key", "scale_id", "level_id_local", "label", "order", "probability_weight", "description"],
    "questions": ["question_key", "bank_id", "question_id", "category_id", "level_key", "prompt", "answer", "explanation", "status", "source_status", "random_order", "order_key"],
    "players": ["player_id", "name", "active"],
    "matches": ["match_id", "name", "bank_id", "player_ids", "enabled_category_ids", "enabled_level_keys", "rules_version", "level_weights_json", "status", "created_at", "closed_at", "close_reason", "seed", "source"],
    "participants": ["match_player_id", "match_id", "player_id", "seat_no", "active"],
    "attempts": ["attempt_id", "match_id", "question_no", "player_id", "question_id", "question_key", "bank_id", "category_id", "level_key", "result_id", "computable", "correct", "quesito_attempt", "quesito_won", "notes", "active", "source", "source_event_id"],
    "exposures": ["exposure_id", "match_id", "bank_id", "question_key", "question_id", "player_id", "question_no", "type", "counts_as_attempt", "reason", "source", "active", "source_event_id"],
    "events": ["event_id", "match_id", "seq", "timestamp", "type", "schema_version", "action_id", "idempotency_key", "payload_json"],
    "meta": ["key", "value"],
}


class SeedError(ValueError):
    pass


@dataclass(frozen=True)
class SeedData:
    tables: dict
    seed_version: str
    digest: str
    files: tuple


def _files(data_dir: Path):
    return {
        "meta": [data_dir / "meta.csv"],
        "banks": [data_dir / "banks.csv"],
        "categories": [data_dir / "categories.csv"],
        "levels": [data_dir / "levels.csv"],
        "questions": sorted(data_dir.glob("questions-*.csv")),
        "players": [data_dir / "players.csv"],
        "matches": [data_dir / "matches.csv"],
        "participants": [data_dir / "participants.csv"],
        "attempts": sorted(data_dir.glob("attempts-*.csv")),
        "exposures": [data_dir / "exposures.csv"],
        "events": [data_dir / "events.csv"],
    }


def _read(path: Path, required):
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise SeedError(f"{path.name}: BOM no permitido")
    rest = raw.replace(b"\r\n", b"")
    if b"\n" in rest or b"\r" in rest:
        raise SeedError(f"{path.name}: se exige CRLF")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise SeedError(f"{path.name}: UTF-8 inválido") from error
    reader = csv.DictReader(io.StringIO(text, newline=""))
    headers = reader.fieldnames or []
    if any(not re.fullmatch(r"[a-z][a-z0-9_]*", header or "") for header in headers):
        raise SeedError(f"{path.name}: cabeceras ASCII inestables")
    missing = [column for column in required if column not in headers]
    if missing:
        raise SeedError(f"{path.name}: faltan columnas {', '.join(missing)}")
    rows = []
    try:
        for number, row in enumerate(reader, 2):
            if None in row:
                raise SeedError(f"{path.name}:{number}: estructura CSV inválida")
            rows.append({key: value for key, value in row.items()})
    except csv.Error as error:
        raise SeedError(f"{path.name}: CSV inválido") from error
    return raw, rows


def _bool(value, field):
    normalized = str(value).strip().lower()
    if normalized in {"true", "1"}:
        return True
    if normalized in {"false", "0"}:
        return False
    raise SeedError(f"{field}: booleano inválido")


def _integer(value, field, minimum=None):
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise SeedError(f"{field}: entero inválido") from error
    if minimum is not None and result < minimum:
        raise SeedError(f"{field}: debe ser >= {minimum}")
    return result


def _json(value, field):
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise SeedError(f"{field}: JSON inválido") from error


def _list(value):
    return [part for part in str(value).split(";") if part]


def _unique(rows, field, table):
    seen = set()
    for row in rows:
        value = row[field]
        if not value or value in seen:
            raise SeedError(f"{table}: {field} vacío o duplicado: {value}")
        seen.add(value)


def load_seed(data_dir: Path):
    file_map = _files(data_dir)
    if not file_map["questions"]:
        raise SeedError("No hay CSV de preguntas")
    if not file_map["attempts"]:
        raise SeedError("No hay CSV de intentos")
    digest = hashlib.sha256()
    tables = {}
    all_files = []
    for table, paths in file_map.items():
        tables[table] = []
        for path in paths:
            if not path.exists():
                raise SeedError(f"Falta {path.name}")
            raw, rows = _read(path, REQUIRED[table])
            digest.update(path.name.encode())
            digest.update(raw)
            tables[table].extend(rows)
            all_files.append(path)
    _validate(tables)
    meta = {row["key"]: row["value"] for row in tables["meta"]}
    seed_version = meta.get("seed_version") or tables["banks"][0]["seed_version"]
    if meta.get("schema_version") != str(SCHEMA_VERSION):
        raise SeedError(f'meta: schema_version debe ser {SCHEMA_VERSION}')
    if meta.get("rules_version") != RULES_VERSION:
        raise SeedError(f'meta: rules_version debe ser {RULES_VERSION}')
    if any(row["seed_version"] != seed_version for row in tables["banks"]):
        raise SeedError("banks: seed_version no coincide con meta")
    return SeedData(tables=tables, seed_version=seed_version, digest=digest.hexdigest(), files=tuple(all_files))


def _validate(tables):
    for table, rows in tables.items():
        for index, row in enumerate(rows, 2):
            for field in REQUIRED[table]:
                if field not in row:
                    raise SeedError(f"{table}:{index}: falta {field}")
    for table, key in [("banks", "bank_id"), ("categories", "category_key"), ("levels", "level_key"), ("questions", "question_key"), ("players", "player_id"), ("matches", "match_id"), ("participants", "match_player_id"), ("attempts", "attempt_id"), ("exposures", "exposure_id"), ("events", "event_id"), ("meta", "key")]:
        _unique(tables[table], key, table)
    bank_ids = {row["bank_id"] for row in tables["banks"]}
    category_keys = {row["category_key"] for row in tables["categories"]}
    level_keys = {row["level_key"] for row in tables["levels"]}
    question_keys = {row["question_key"] for row in tables["questions"]}
    player_ids = {row["player_id"] for row in tables["players"]}
    match_ids = {row["match_id"] for row in tables["matches"]}
    prompts = set()
    order_keys = set()
    answer_stopwords = {"a", "de", "del", "el", "en", "la", "las", "los", "o", "para", "por", "un", "una", "y"}
    for row in tables["categories"]:
        if row["bank_id"] not in bank_ids or row["category_key"] != f'{row["bank_id"]}|{row["category_id"]}':
            raise SeedError(f'categories: FK/clave inválida {row["category_key"]}')
        _bool(row["active"], row["category_key"])
        _bool(row["quesito_default"], row["category_key"])
    for row in tables["levels"]:
        if row["level_key"] != f'{row["scale_id"]}|{row["level_id_local"]}':
            raise SeedError(f'levels: clave inválida {row["level_key"]}')
        _integer(row["order"], row["level_key"], 0)
        _integer(row["probability_weight"], row["level_key"], 1)
    for row in tables["questions"]:
        required_text = ["bank_id", "question_id", "question_key", "category_id", "level_key", "prompt", "answer", "explanation", "status", "order_key"]
        if any(not row[field].strip() for field in required_text):
            raise SeedError(f'questions: obligatorio vacío {row["question_key"]}')
        if row["question_key"] != f'{row["bank_id"]}|{row["question_id"]}':
            raise SeedError(f'questions: clave inválida {row["question_key"]}')
        if row["bank_id"] not in bank_ids or f'{row["bank_id"]}|{row["category_id"]}' not in category_keys or row["level_key"] not in level_keys:
            raise SeedError(f'questions: FK inválida {row["question_key"]}')
        if row["status"] not in {"active", "retired"}:
            raise SeedError(f'questions: estado inválido {row["question_key"]}')
        if not row["prompt"].endswith("?") or len(row["prompt"]) > 220 or len(row["answer"]) > 120 or len(row["explanation"]) > 300:
            raise SeedError(f'questions: formato editorial inválido {row["question_key"]}')
        normalized = re.sub(r"\s+", " ", row["prompt"].strip().casefold())
        if normalized in prompts:
            raise SeedError(f'questions: enunciado duplicado {row["question_key"]}')
        prompts.add(normalized)
        normalized_prompt = re.sub(r"[^a-z0-9 ]", " ", re.sub(r"[\u0300-\u036f]", "", unicodedata.normalize("NFD", row["prompt"].casefold())))
        normalized_answer = re.sub(r"[^a-z0-9 ]", " ", re.sub(r"[\u0300-\u036f]", "", unicodedata.normalize("NFD", row["answer"].casefold())))
        answer_phrase = " ".join(word for word in normalized_answer.split() if word not in answer_stopwords)
        if len(answer_phrase) >= 4 and answer_phrase in " ".join(normalized_prompt.split()):
            raise SeedError(f'questions: respuesta revelada en enunciado {row["question_key"]}')
        order_identity = (row["bank_id"], row["order_key"])
        if order_identity in order_keys:
            raise SeedError(f'questions: order_key duplicada {row["question_key"]}')
        order_keys.add(order_identity)
        _integer(row["random_order"], row["question_key"], 0)
    for row in tables["players"]:
        _bool(row["active"], row["player_id"])
    for row in tables["matches"]:
        if row["bank_id"] not in bank_ids:
            raise SeedError(f'matches: banco inválido {row["match_id"]}')
        if any(player not in player_ids for player in _list(row["player_ids"])):
            raise SeedError(f'matches: jugador inválido {row["match_id"]}')
        if any(f'{row["bank_id"]}|{category}' not in category_keys for category in _list(row["enabled_category_ids"])):
            raise SeedError(f'matches: categoría inválida {row["match_id"]}')
        if any(level not in level_keys for level in _list(row["enabled_level_keys"])):
            raise SeedError(f'matches: nivel inválido {row["match_id"]}')
        _json(row["level_weights_json"], row["match_id"])
    for row in tables["participants"]:
        if row["match_id"] not in match_ids or row["player_id"] not in player_ids:
            raise SeedError(f'participants: FK inválida {row["match_player_id"]}')
        _integer(row["seat_no"], row["match_player_id"], 1)
    for row in tables["attempts"]:
        if row["match_id"] not in match_ids or row["player_id"] not in player_ids or row["question_key"] not in question_keys:
            raise SeedError(f'attempts: FK inválida {row["attempt_id"]}')
        for field in ["computable", "quesito_attempt", "quesito_won", "active"]:
            _bool(row[field], f'{row["attempt_id"]}.{field}')
        if row["correct"]:
            _bool(row["correct"], f'{row["attempt_id"]}.correct')
        elif _bool(row["computable"], f'{row["attempt_id"]}.computable'):
            raise SeedError(f'attempts: resultado obligatorio {row["attempt_id"]}')
    for row in tables["exposures"]:
        if row["match_id"] not in match_ids or row["player_id"] not in player_ids or row["question_key"] not in question_keys:
            raise SeedError(f'exposures: FK inválida {row["exposure_id"]}')
    seqs = set()
    idempotency = set()
    for row in tables["events"]:
        if row["match_id"] not in match_ids:
            raise SeedError(f'events: partida inválida {row["event_id"]}')
        seq = (row["match_id"], _integer(row["seq"], row["event_id"], 1))
        if seq in seqs:
            raise SeedError(f'events: seq duplicada {row["event_id"]}')
        seqs.add(seq)
        if row["idempotency_key"]:
            if row["idempotency_key"] in idempotency:
                raise SeedError(f'events: idempotencia duplicada {row["event_id"]}')
            idempotency.add(row["idempotency_key"])
        _json(row["payload_json"], row["event_id"])
    per_bank = {bank_id: 0 for bank_id in bank_ids}
    for row in tables["questions"]:
        per_bank[row["bank_id"]] += 1
    for row in tables["banks"]:
        if _integer(row["question_count"], row["bank_id"], 0) != per_bank[row["bank_id"]]:
            raise SeedError(f'banks: question_count incorrecto {row["bank_id"]}')


def as_bool(value):
    return _bool(value, "boolean")


def as_int(value, minimum=0):
    return _integer(value, "integer", minimum)


def as_json(value):
    return _json(value, "json")


def as_list(value):
    return _list(value)
