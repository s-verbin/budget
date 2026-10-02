#!/usr/bin/env python3
"""Личный сервис бюджета: статические файлы + JSON API поверх SQLite.

Запуск: python3 server.py [порт]   (по умолчанию 8765, слушает только 127.0.0.1)
База лежит рядом: budget.db. Внешних зависимостей нет.
BUDGET_HOST меняет адрес прослушивания (нужно только в контейнере — см. Dockerfile).

Демо-режим (BUDGET_DEMO=1) на диск вообще ничего не пишет: у каждого посетителя
(анонимная cookie-сессия, без входа) своя база в оперативной памяти процесса —
общий кэш SQLite с именем на сессию, без журнала на диске. Она живёт, пока открыта
вкладка и сервис не перезапускался; при простое дольше SESSION_IDLE_SECONDS или
при перезапуске сервиса пропадает без следа. См. connect()/_touch_session().
"""
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEFAULT_PORT = 8765
DB_PATH = Path(os.environ.get("BUDGET_DB") or ROOT / "budget.db")

# Публичная демо-версия (сайт): BUDGET_DEMO=1 включает cookie-сессии с базой
# только в памяти (см. модульный docstring) и баннер «это песочница».
# BUDGET_REPO_URL — ссылка на исходники в подвале страницы. Ни то, ни другое
# не включено по умолчанию: локальный self-hosted запуск ничего лишнего не
# показывает и всегда пишет в свой файл на диске.
DEMO_MODE = os.environ.get("BUDGET_DEMO") == "1"
REPO_URL = os.environ.get("BUDGET_REPO_URL") or ""


def inject_footer(html: bytes) -> bytes:
    pieces = []
    if DEMO_MODE:
        if REPO_URL:
            call_to_action = '<a href="%s">скачайте проект с GitHub</a> и запустите его у себя.' % REPO_URL
        else:
            call_to_action = "скачайте проект и запустите его у себя."
        pieces.append(
            '<div id="demo-banner" role="note">Это публичная песочница: ничего не сохраняется на диск. '
            "У вас своя память на время визита, она пропадает при простое или перезапуске сервиса, "
            "и никто другой её не видит. Для своего бюджета — " + call_to_action + "</div>"
        )
    if REPO_URL:
        pieces.append('<footer id="repo-footer"><a href="%s" target="_blank" rel="noopener">Исходный код на GitHub</a></footer>' % REPO_URL)
    if not pieces:
        return html
    snippet = ("\n".join(pieces)).encode("utf-8")
    return html.replace(b"</body>", snippet + b"</body>", 1)

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start TEXT NOT NULL,
    horizon INTEGER NOT NULL DEFAULT 24,
    opening REAL NOT NULL DEFAULT 0,
    reserve REAL NOT NULL DEFAULT 0,
    deposit_rate REAL NOT NULL DEFAULT 0,
    deposit_tax REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    name TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    every INTEGER NOT NULL DEFAULT 1,
    until TEXT,
    category TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    principal REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    term INTEGER NOT NULL DEFAULT 12,
    start TEXT NOT NULL,
    down_payment REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prepayments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    every INTEGER NOT NULL DEFAULT 0,
    until TEXT,
    mode TEXT NOT NULL DEFAULT 'term' CHECK (mode IN ('term', 'payment'))
);
CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    opening REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    start TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposit_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deposit_id INTEGER NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    every INTEGER NOT NULL DEFAULT 0,
    until TEXT
);
CREATE TABLE IF NOT EXISTS actuals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    UNIQUE(item_id, month)
);
"""

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def month_str(v):
    if not isinstance(v, str) or not MONTH_RE.match(v):
        raise ValueError("ожидается месяц в формате ГГГГ-ММ")
    return v


def month_or_none(v):
    return None if v in (None, "") else month_str(v)


def text(v):
    return str(v or "").strip()[:200]


def money(v):
    v = float(v)
    if v < 0 or v != v or v in (float("inf"),):
        raise ValueError("сумма должна быть неотрицательным числом")
    return v


def percent(v):
    v = float(v)
    if not 0 <= v <= 100:
        raise ValueError("процент должен быть от 0 до 100")
    return v


def integer(lo, hi):
    def conv(v):
        v = int(v)
        if not lo <= v <= hi:
            raise ValueError(f"значение должно быть от {lo} до {hi}")
        return v
    return conv


def one_of(*allowed):
    def conv(v):
        if v not in allowed:
            raise ValueError("недопустимое значение: " + str(v))
        return v
    return conv


# Для каждой таблицы: поле -> функция проверки. Только эти поля можно записать.
TABLES = {
    "items": {
        "kind": one_of("income", "expense"), "name": text, "amount": money,
        "start": month_str, "every": one_of(0, 1, 3, 6, 12), "until": month_or_none, "category": text,
    },
    "loans": {
        "name": text, "principal": money, "rate": money, "term": integer(1, 600),
        "start": month_str, "down_payment": money,
    },
    "prepayments": {
        "loan_id": integer(1, 2**31), "amount": money, "start": month_str,
        "every": one_of(0, 1, 3, 6, 12), "until": month_or_none, "mode": one_of("term", "payment"),
    },
    "deposits": {
        "name": text, "opening": money, "rate": money, "tax": percent, "start": month_str,
    },
    "deposit_contributions": {
        "deposit_id": integer(1, 2**31), "amount": money, "start": month_str,
        "every": one_of(0, 1, 3, 6, 12), "until": month_or_none,
    },
    "actuals": {
        "item_id": integer(1, 2**31), "month": month_str, "amount": money,
    },
}
SETTINGS_FIELDS = {
    "start": month_str, "horizon": one_of(12, 24, 36, 60), "opening": float, "reserve": money,
}


def _apply_schema(con):
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    cols = {r["name"] for r in con.execute("PRAGMA table_info(items)")}
    if "category" not in cols:
        con.execute("ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT ''")
    today = date.today()
    con.execute(
        "INSERT OR IGNORE INTO settings (id, start) VALUES (1, ?)",
        (f"{today.year:04d}-{today.month:02d}",),
    )
    con.commit()


def init_db():
    con = sqlite3.connect(DB_PATH)
    try:
        _apply_schema(con)
    finally:
        con.close()


# --- демо-сессии: in-memory база на посетителя, см. модульный docstring.
SESSION_COOKIE = "budget_session"
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
SESSION_IDLE_SECONDS = 2 * 60 * 60   # не трогали 2 часа — можно закрыть
SESSION_MAX_COUNT = 1000             # защита от неограниченного роста памяти

_sessions_lock = threading.Lock()
_sessions = {}   # sid -> {"keeper": sqlite3.Connection, "last": float}


def _demo_uri(sid):
    # cache=shared: разные соединения с одним и тем же именем видят одну и ту же
    # базу в памяти процесса, пока жив хотя бы «keeper»-коннект на эту сессию.
    return "file:budget-demo-%s?mode=memory&cache=shared" % sid


def _touch_session(sid):
    now = time.time()
    with _sessions_lock:
        entry = _sessions.get(sid)
        if entry is None:
            keeper = sqlite3.connect(_demo_uri(sid), uri=True, check_same_thread=False)
            _apply_schema(keeper)
            entry = {"keeper": keeper, "last": now}
            _sessions[sid] = entry
        entry["last"] = now
        _evict_locked(now)


def _evict_locked(now):
    stale = [s for s, e in _sessions.items() if now - e["last"] > SESSION_IDLE_SECONDS]
    if len(_sessions) - len(stale) > SESSION_MAX_COUNT:
        rest = sorted((s for s in _sessions if s not in stale), key=lambda s: _sessions[s]["last"])
        stale += rest[: len(_sessions) - len(stale) - SESSION_MAX_COUNT]
    for s in stale:
        _sessions.pop(s)["keeper"].close()


def connect(sid=None):
    if sid is not None:
        _touch_session(sid)
        con = sqlite3.connect(_demo_uri(sid), uri=True)
    else:
        con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def rows(con, table):
    return [dict(r) for r in con.execute(f"SELECT * FROM {table} ORDER BY id")]


def full_state(con):
    return {
        "settings": dict(con.execute("SELECT start, horizon, opening, reserve FROM settings").fetchone()),
        "items": rows(con, "items"),
        "loans": rows(con, "loans"),
        "prepayments": rows(con, "prepayments"),
        "deposits": rows(con, "deposits"),
        "deposit_contributions": rows(con, "deposit_contributions"),
        "actuals": rows(con, "actuals"),
    }


def clean(table_fields, data, partial):
    if not isinstance(data, dict):
        raise ValueError("ожидается JSON-объект")
    out = {}
    for field, conv in table_fields.items():
        if field in data:
            out[field] = conv(data[field])
        elif not partial and field in ("start", "kind", "loan_id", "deposit_id", "item_id"):
            raise ValueError(f"нет поля {field}")
    return out


def seed_demo(con):
    """Пример данных. Вызывается только на пустой базе."""
    t = date.today()
    now = t.year * 12 + t.month - 1

    def ym(offset):
        i = now + offset
        return f"{i // 12:04d}-{i % 12 + 1:02d}"

    con.execute("UPDATE settings SET start=?, horizon=24, opening=1500000, reserve=200000 WHERE id=1", (ym(0),))
    items = [
        ("income", "Зарплата", 250000, ym(0), 1, None, ""),
        ("income", "Годовая премия", 300000, ym((12 - t.month) % 12 or 12), 12, None, ""),
        ("expense", "Продукты", 40000, ym(0), 1, None, "Еда"),
        ("expense", "ЖКУ и связь", 12000, ym(0), 1, None, "Жильё"),
        ("expense", "Транспорт", 8000, ym(0), 1, None, "Транспорт"),
        ("expense", "Кафе и развлечения", 15000, ym(0), 1, None, "Развлечения"),
        ("expense", "Отпуск", 150000, ym(11), 12, None, "Путешествия"),
        ("expense", "Страховка авто", 30000, ym(6), 12, None, "Транспорт"),
        ("expense", "Налог на имущество", 6000, ym(2), 12, None, "Жильё"),
    ]
    con.executemany("INSERT INTO items (kind, name, amount, start, every, until, category) VALUES (?,?,?,?,?,?,?)", items)
    prod = con.execute("SELECT id FROM items WHERE name='Продукты' AND kind='expense'").fetchone()[0]
    con.execute("INSERT INTO actuals (item_id, month, amount) VALUES (?,?,?)", (prod, ym(0), 42300))
    con.execute("INSERT INTO loans (name, principal, rate, term, start, down_payment) VALUES (?,?,?,?,?,?)",
                ("Автокредит", 900000, 14, 36, ym(0), 0))
    cur = con.execute("INSERT INTO loans (name, principal, rate, term, start, down_payment) VALUES (?,?,?,?,?,?)",
                      ("Ипотека на новую квартиру", 8000000, 12, 240, ym(4), 2000000))
    con.execute("INSERT INTO prepayments (loan_id, amount, start, every, until, mode) VALUES (?,?,?,?,?,?)",
                (cur.lastrowid, 300000, ym(15), 0, None, "term"))
    dep = con.execute("INSERT INTO deposits (name, opening, rate, tax, start) VALUES (?,?,?,?,?)",
                       ("Накопительный счёт", 300000, 15, 13, ym(0)))
    con.execute("INSERT INTO deposit_contributions (deposit_id, amount, start, every, until) VALUES (?,?,?,?,?)",
                (dep.lastrowid, 20000, ym(0), 1, None))


class Handler(BaseHTTPRequestHandler):
    server_version = "Budget/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    # --- cookie демо-сессии (см. модульный docstring); None вне демо-режима
    def session_id(self):
        if not DEMO_MODE:
            return None
        raw = self.headers.get("Cookie")
        if raw:
            jar = SimpleCookie()
            try:
                jar.load(raw)
            except Exception:
                jar = {}
            morsel = jar.get(SESSION_COOKIE) if jar else None
            if morsel and SESSION_ID_RE.match(morsel.value):
                return morsel.value
        sid = secrets.token_urlsafe(18)
        self._new_session_cookie = sid
        return sid

    def _set_cookie_header(self):
        sid = getattr(self, "_new_session_cookie", None)
        if sid:
            self.send_header("Set-Cookie", "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" % (SESSION_COOKIE, sid))

    # --- ответы
    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._set_cookie_header()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ValueError("слишком большой запрос")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValueError("некорректный JSON")

    # --- статика
    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self.send_error_json(HTTPStatus.NOT_FOUND, "не найдено")
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        if rel == "index.html":
            if DEMO_MODE:
                self.session_id()   # заводит cookie сессии уже на первой загрузке страницы
            if REPO_URL or DEMO_MODE:
                body = inject_footer(body)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._set_cookie_header()
        self.end_headers()
        self.wfile.write(body)

    # --- маршруты
    def route(self, method):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            if method != "GET":
                return self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "только GET")
            return self.serve_static(path)

        sid = self.session_id()
        parts = path[len("/api/"):].strip("/").split("/")
        con = connect(sid)
        try:
            result = self.api(con, method, parts)
            con.commit()
            return result
        except (ValueError, TypeError) as e:
            con.rollback()
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except sqlite3.IntegrityError as e:
            con.rollback()
            self.send_error_json(HTTPStatus.BAD_REQUEST, "нарушено ограничение базы: " + str(e))
        finally:
            con.close()

    def api(self, con, method, parts):
        head = parts[0]
        if head == "state" and method == "GET":
            return self.send_json(full_state(con))

        if head == "settings" and method == "PUT":
            data = clean(SETTINGS_FIELDS, self.read_json(), partial=True)
            if data:
                sets = ", ".join(f"{k} = ?" for k in data)
                con.execute(f"UPDATE settings SET {sets} WHERE id = 1", list(data.values()))
            return self.send_json(full_state(con)["settings"])

        if head == "demo" and method == "POST":
            empty = not any(con.execute(f"SELECT 1 FROM {t} LIMIT 1").fetchone() for t in TABLES)
            if not empty:
                return self.send_error_json(HTTPStatus.CONFLICT, "пример можно загрузить только в пустую базу")
            seed_demo(con)
            return self.send_json(full_state(con))

        if head in TABLES:
            fields = TABLES[head]
            if method == "POST" and len(parts) == 1:
                data = clean(fields, self.read_json(), partial=False)
                data = {**{k: _default(head, k) for k in fields if k not in data and _default(head, k) is not None}, **data}
                cols = ", ".join(data)
                marks = ", ".join("?" for _ in data)
                cur = con.execute(f"INSERT INTO {head} ({cols}) VALUES ({marks})", list(data.values()))
                row = con.execute(f"SELECT * FROM {head} WHERE id = ?", (cur.lastrowid,)).fetchone()
                return self.send_json(dict(row), HTTPStatus.CREATED)
            if len(parts) == 2 and parts[1].isdigit():
                rid = int(parts[1])
                if method == "PUT":
                    data = clean(fields, self.read_json(), partial=True)
                    if data:
                        sets = ", ".join(f"{k} = ?" for k in data)
                        cur = con.execute(f"UPDATE {head} SET {sets} WHERE id = ?", [*data.values(), rid])
                        if not cur.rowcount:
                            return self.send_error_json(HTTPStatus.NOT_FOUND, "запись не найдена")
                    return self.send_json({"ok": True})
                if method == "DELETE":
                    con.execute(f"DELETE FROM {head} WHERE id = ?", (rid,))
                    return self.send_json({"ok": True})
        self.send_error_json(HTTPStatus.NOT_FOUND, "нет такого метода API")

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PUT(self): self.route("PUT")
    def do_DELETE(self): self.route("DELETE")


def _default(table, field):
    return {"name": "", "amount": 0, "every": 1 if table == "items" else 0, "until": None,
            "principal": 0, "rate": 0, "term": 12, "down_payment": 0, "mode": "term",
            "opening": 0, "tax": 0}.get(field)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    # По умолчанию только с этого же компьютера — см. README. BUDGET_HOST=0.0.0.0
    # нужен лишь внутри контейнера (Docker публикует порт сам, см. Dockerfile);
    # на голом хосте так делать не стоит — сервер тогда виден всей сети.
    host = os.environ.get("BUDGET_HOST") or "127.0.0.1"
    if not DEMO_MODE:
        init_db()
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        sys.exit(f"Не удалось занять порт {port}: {e.strerror}. Укажите другой: python3 server.py {port + 1}")
    shown_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    if DEMO_MODE:
        print(f"Бюджет (демо): http://{shown_host}:{port}  — ничего не пишет на диск, остановить: Ctrl+C")
    else:
        print(f"Бюджет: http://{shown_host}:{port}  (база: {DB_PATH.name}, остановить: Ctrl+C)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено")


if __name__ == "__main__":
    main()
