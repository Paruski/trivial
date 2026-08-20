import hmac
import json
import mimetypes
import os
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import BUILD_VERSION, DATA_DIR, EVENT_SCHEMA_VERSION, ROOT, RULES_VERSION, SCHEMA_VERSION, VAR_DIR
from .domain import GameError, GameService
from .maintenance import create_backup, diagnose, reset_to_seed, restore_backup
from .seed import load_seed
from .statistics import compute_statistics
from .storage import Database, compact_json, utc_now


class SeedWatcher:
    def __init__(self, database, data_dir=DATA_DIR, interval=5):
        self.database = database
        self.data_dir = Path(data_dir)
        self.interval = interval
        self.current = None
        self.error = None
        self.last_checked_at = None
        self._file_signature = None
        self._stop = threading.Event()
        self._thread = None

    def refresh(self, force=False):
        self.last_checked_at = utc_now()
        try:
            signature = tuple((path.name, path.stat().st_mtime_ns, path.stat().st_size) for path in sorted(self.data_dir.glob("*.csv")))
            if not force and self.current is not None and signature == self._file_signature:
                return False
            seed = load_seed(self.data_dir)
            changed = self.database.sync_seed(seed, force=force)
            self.current = seed
            self._file_signature = signature
            self.error = None
            return changed
        except Exception as error:
            self.error = str(error)
            self.database.seed_error = self.error
            if self.current is None:
                raise
            return False

    def start(self):
        self.refresh()
        self._thread = threading.Thread(target=self._run, name="seed-watcher", daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.wait(self.interval):
            self.refresh()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def status(self):
        return {
            "seedVersion": self.current.seed_version if self.current else None,
            "seedDigest": self.current.digest if self.current else None,
            "lastCheckedAt": self.last_checked_at,
            "error": self.error,
        }


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, database, watcher, admin_token=None):
        token = admin_token or ""
        if token and len(token) < 16:
            raise ValueError("TRIVIAL_ADMIN_TOKEN debe tener al menos 16 caracteres")
        super().__init__(address, RequestHandler)
        self.database = database
        self.watcher = watcher
        self.database.verify_integrity()
        self.games = GameService(database)
        self.games.reconcile_all()
        self.admin_token = token

    def admin_authorized(self, header):
        if not self.admin_token:
            return False
        value = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
        return hmac.compare_digest(value.encode(), self.admin_token.encode())


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "TrivialServer/4"

    def log_message(self, format_string, *args):
        print(f'{self.address_string()} - {format_string % args}')

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def _dispatch(self, method):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path.startswith("/api/"):
                self._api(method, parsed.path)
            elif method in {"GET", "HEAD"}:
                self._static(parsed.path, head=method == "HEAD")
            else:
                self._json_error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Método no permitido.")
        except GameError as error:
            self._json_error(error.status, error.code, str(error))
        except json.JSONDecodeError:
            self._json_error(HTTPStatus.BAD_REQUEST, "INVALID_JSON", "JSON inválido.")
        except BrokenPipeError:
            pass
        except Exception as error:
            print(f"ERROR {type(error).__name__}: {error}")
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Error interno del servidor.")

    def _session(self):
        cookies = {}
        for part in self.headers.get("Cookie", "").split(";"):
            if "=" in part:
                key, value = part.strip().split("=", 1)
                cookies[key] = value
        token = cookies.get("trivial_session")
        session_id = self.server.database.resolve_session(token) if token else None
        if session_id:
            return session_id, None
        session_id, token = self.server.database.create_session()
        secure = self.headers.get("X-Forwarded-Proto") == "https" or os.getenv("TRIVIAL_SECURE_COOKIE", "").lower() in {"1", "true", "yes"}
        cookie = f"trivial_session={token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict" + ("; Secure" if secure else "")
        return session_id, cookie

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urllib.parse.urlsplit(origin)
        return parsed.netloc == self.headers.get("Host") and parsed.scheme in {"http", "https"}

    def _read_json(self):
        if not self._origin_ok():
            raise GameError("Origen no permitido.", "BAD_ORIGIN", 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise GameError("Content-Length inválido.") from error
        if length <= 0 or length > 25 * 1024 * 1024:
            raise GameError("Cuerpo vacío o demasiado grande.", "INVALID_BODY", 413)
        return json.loads(self.rfile.read(length).decode("utf-8", "strict"))

    def _request_id(self, payload):
        value = self.headers.get("Idempotency-Key") or payload.get("requestId")
        if not isinstance(value, str) or not 8 <= len(value) <= 160:
            raise GameError("Falta una clave de idempotencia válida.", "IDEMPOTENCY_REQUIRED")
        return value

    def _api(self, method, path):
        if method == "GET" and path == "/api/health":
            status = self.server.watcher.status()
            code = HTTPStatus.OK if not status["error"] else HTTPStatus.SERVICE_UNAVAILABLE
            self._json(code, {"ok": not status["error"], "database": "ok", "seed": status, "revision": self.server.database.revision()})
            return
        if method == "GET" and path == "/api/revision":
            self._json(HTTPStatus.OK, {"revision": self.server.database.revision(), "serverTime": utc_now()})
            return
        session_id, cookie = self._session()
        if method == "GET" and path == "/api/bootstrap":
            self._json(HTTPStatus.OK, self._bootstrap(session_id), cookie=cookie)
            return
        if method == "GET" and path == "/api/statistics":
            self._json(HTTPStatus.OK, compute_statistics(self.server.database), cookie=cookie)
            return
        if method == "GET" and path == "/api/diagnostics":
            self._json(HTTPStatus.OK, diagnose(self.server.database, self.server.watcher.status()), cookie=cookie)
            return
        if method == "GET" and path.startswith("/api/matches/"):
            match_id = urllib.parse.unquote(path.removeprefix("/api/matches/"))
            self._json(HTTPStatus.OK, self.server.games.detail(match_id, session_id), cookie=cookie)
            return
        if method == "POST" and path == "/api/matches":
            payload = self._read_json()
            result = self.server.games.create_match(session_id, payload, self._request_id(payload))
            self._json(HTTPStatus.CREATED, result, cookie=cookie)
            return
        if method == "POST" and path.startswith("/api/matches/") and path.endswith("/actions"):
            match_id = urllib.parse.unquote(path.removeprefix("/api/matches/").removesuffix("/actions"))
            payload = self._read_json()
            result = self.server.games.perform_action(match_id, session_id, payload, self._request_id(payload))
            self._json(HTTPStatus.OK, result, cookie=cookie)
            return
        if path.startswith("/api/admin/"):
            if not self.server.admin_authorized(self.headers.get("Authorization", "")):
                code = HTTPStatus.SERVICE_UNAVAILABLE if not self.server.admin_token else HTTPStatus.UNAUTHORIZED
                self._json_error(code, "ADMIN_AUTH", "Configura o introduce la clave administrativa.", cookie=cookie)
                return
            if method == "GET" and path == "/api/admin/backup":
                name = f'trivial-backup-{utc_now()[:10]}.json'
                self._json(HTTPStatus.OK, create_backup(self.server.database), cookie=cookie, disposition=f'attachment; filename="{name}"')
                return
            if method == "POST" and path == "/api/admin/restore":
                payload = self._read_json()
                try:
                    restore_backup(self.server.database, payload, session_id)
                except ValueError as error:
                    raise GameError(f"Copia rechazada: {error}", "INVALID_BACKUP") from error
                self._json(HTTPStatus.OK, {"ok": True, "revision": self.server.database.revision()}, cookie=cookie)
                return
            if method == "POST" and path == "/api/admin/reset":
                self.server.watcher.refresh(force=True)
                if self.server.watcher.error:
                    raise GameError(f'Los CSV no son válidos: {self.server.watcher.error}', "SEED_INVALID", 422)
                reset_to_seed(self.server.database)
                self._json(HTTPStatus.OK, {"ok": True, "revision": self.server.database.revision()}, cookie=cookie)
                return
            if method == "POST" and path == "/api/admin/reload-seed":
                changed = self.server.watcher.refresh(force=True)
                if self.server.watcher.error:
                    raise GameError(f'Los CSV no son válidos: {self.server.watcher.error}', "SEED_INVALID", 422)
                self._json(HTTPStatus.OK, {"ok": True, "changed": changed, "seed": self.server.watcher.status(), "revision": self.server.database.revision()}, cookie=cookie)
                return
        self._json_error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Ruta no encontrada.", cookie=cookie)

    def _bootstrap(self, session_id):
        with self.server.database.snapshot() as database:
            return self._bootstrap_snapshot(session_id, database)

    def _bootstrap_snapshot(self, session_id, database):
        categories = [{"categoryKey": row["category_key"], "bankId": row["bank_id"], "categoryId": row["category_id"], "label": row["label"], "color": row["color"], "emoji": row["emoji"], "active": bool(row["active"])} for row in database.query("SELECT * FROM categories ORDER BY bank_id,category_id")]
        levels = [{"levelKey": row["level_key"], "scaleId": row["scale_id"], "levelIdLocal": row["level_id_local"], "label": row["label"], "order": row["sort_order"], "probabilityWeight": row["probability_weight"], "description": row["description"]} for row in database.query("SELECT * FROM levels ORDER BY sort_order,level_key")]
        stock = [{"bankId": row["bank_id"], "categoryId": row["category_id"], "levelKey": row["level_key"], "count": row["count"]} for row in database.query("""
            SELECT q.bank_id,q.category_id,q.level_key,SUM(CASE WHEN r.question_key IS NULL THEN 1 ELSE 0 END) count
            FROM questions q LEFT JOIN question_retirements r ON r.question_key=q.question_key
            WHERE q.seed_status='active'
            GROUP BY q.bank_id,q.category_id,q.level_key
        """)]
        meta = {row["key"]: row["value"] for row in database.query("SELECT * FROM runtime_meta")}
        return {
            "versions": {"buildVersion": BUILD_VERSION, "seedVersion": meta.get("seed_version"), "schemaVersion": SCHEMA_VERSION, "eventSchemaVersion": EVENT_SCHEMA_VERSION, "rulesVersion": RULES_VERSION},
            "banks": [{"bankId": row["bank_id"], "name": row["name"], "questionCount": row["question_count"]} for row in database.query("SELECT * FROM banks ORDER BY bank_id")],
            "categories": categories,
            "levels": levels,
            "players": [{"playerId": row["player_id"], "name": row["name"], "active": bool(row["active"])} for row in database.query("SELECT * FROM players ORDER BY player_id")],
            "matches": self.server.games.list_matches(session_id, database),
            "base": {"questionCount": database.one("SELECT COUNT(*) count FROM questions")["count"], "activeQuestionCount": database.one("SELECT COUNT(*) count FROM questions q LEFT JOIN question_retirements r ON r.question_key=q.question_key WHERE q.seed_status='active' AND r.question_key IS NULL")["count"], "globalRetirements": database.one("SELECT COUNT(*) count FROM question_retirements")["count"], "stock": stock},
            "seed": self.server.watcher.status(),
            "revision": database.revision(),
            "serverTime": utc_now(),
            "adminConfigured": bool(self.server.admin_token),
        }

    def _static(self, raw_path, head=False):
        path = urllib.parse.unquote(raw_path)
        if path == "/":
            relative = Path("index.html")
        else:
            relative = Path(path.lstrip("/"))
        allowed = {"index.html", "styles.css", "manifest.webmanifest", "sw.js", "icons/trivial.svg", "src/app.js", "src/api.js"}
        if str(relative) not in allowed:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        candidate = (ROOT / relative).resolve()
        if ROOT not in candidate.parents and candidate != ROOT:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        content = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") or mime in {"application/javascript", "application/json"} else mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache" if relative.name in {"index.html", "sw.js"} else "public,max-age=3600")
        self._security_headers()
        self.end_headers()
        if not head:
            self.wfile.write(content)

    def _security_headers(self):
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(),microphone=(),geolocation=()")

    def _json(self, status, payload, cookie=None, disposition=None):
        content = compact_json(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self._security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _json_error(self, status, code, message, cookie=None):
        if self.wfile.closed:
            return
        self._json(status, {"error": {"code": code, "message": message}}, cookie=cookie)


def run(host="127.0.0.1", port=8080, database_path=None):
    path = Path(database_path or os.getenv("TRIVIAL_DATABASE", VAR_DIR / "trivial.sqlite3"))
    database = Database(path)
    watcher = SeedWatcher(database)
    watcher.start()
    server = AppServer((host, port), database, watcher, os.getenv("TRIVIAL_ADMIN_TOKEN"))
    print(f"Trivial disponible en http://{host}:{port}")
    if not server.admin_token:
        print("Administración desactivada: define TRIVIAL_ADMIN_TOKEN")
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        watcher.stop()
        server.server_close()
