import http.cookiejar
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server.api import AppServer, SeedWatcher
from server.storage import Database


class ApiCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        database = Database(Path(self.temporary.name) / "api.sqlite3")
        watcher = SeedWatcher(database)
        watcher.refresh()
        self.server = AppServer(("127.0.0.1", 0), database, watcher, "administration-token-123")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.counter = 0

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def get(self, path, opener=None, headers=None):
        request = urllib.request.Request(self.base + path, headers=headers or {})
        with (opener or self.opener).open(request) as response:
            return response.status, json.load(response), response.headers

    def post(self, path, payload, opener=None, token=None):
        self.counter += 1
        request_id = f"api-request-{self.counter:04d}"
        body = {**payload, "requestId": request_id}
        headers = {"Content-Type": "application/json", "Idempotency-Key": request_id}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers=headers, method="POST")
        with (opener or self.opener).open(request) as response:
            return response.status, json.load(response)

    def test_static_bootstrap_session_and_security_headers(self):
        status, health, headers = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertIsNone(headers["Set-Cookie"])
        self.assertEqual(self.server.database.one("SELECT COUNT(*) count FROM sessions")["count"], 0)
        status, bootstrap, headers = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["base"]["questionCount"], 726)
        self.assertIn("trivial_session=", headers["Set-Cookie"])
        self.assertEqual(self.server.database.one("SELECT COUNT(*) count FROM sessions")["count"], 1)
        request = urllib.request.Request(self.base + "/")
        with self.opener.open(request) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        with self.assertRaises(urllib.error.HTTPError) as blocked:
            self.opener.open(self.base + "/data/questions-AL.csv")
        self.assertEqual(blocked.exception.code, 404)

    def test_match_is_central_and_owned_by_session(self):
        self.get("/api/bootstrap")
        status, created = self.post("/api/matches", {"bankId": "B2026-08-18", "playerIds": ["J1", "J3"], "categoryIds": ["AL", "IN"], "levelKeys": ["S_DIFICULTAD_TRIVIAL_V1|CUR"]})
        self.assertEqual(status, 201)
        match_id = created["match"]["matchId"]
        self.post(f"/api/matches/{match_id}/actions", {"action": "select_turn", "playerId": "J3"})
        _, drawn = self.post(f"/api/matches/{match_id}/actions", {"action": "draw", "categoryId": "AL", "quesitoAttempt": False})
        self.assertNotIn("answer", drawn["state"]["currentDraw"])
        second = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.get("/api/bootstrap", second)
        _, visible, _ = self.get(f"/api/matches/{match_id}", second)
        self.assertFalse(visible["writable"])
        with self.assertRaises(urllib.error.HTTPError) as forbidden:
            self.post(f"/api/matches/{match_id}/actions", {"action": "reveal"}, second)
        self.assertEqual(forbidden.exception.code, 403)

    def test_admin_backup_and_reset_require_token(self):
        self.get("/api/bootstrap")
        with self.assertRaises(urllib.error.HTTPError) as unauthorized:
            self.get("/api/admin/backup")
        self.assertEqual(unauthorized.exception.code, 401)
        _, backup, _ = self.get("/api/admin/backup", headers={"Authorization": "Bearer administration-token-123"})
        self.assertEqual(backup["backupVersion"], 1)
        status, result = self.post("/api/admin/reset", {}, token="administration-token-123")
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
