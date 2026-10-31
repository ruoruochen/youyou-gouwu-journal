#!/usr/bin/env python3
"""Local workbench CLI. No browser credentials, external requests or telemetry."""
from __future__ import annotations

import argparse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sys
from urllib.parse import unquote, urlsplit

from journal_store import Store, RevisionConflict, atomic_json, encoded, init_project


MAX_BODY = 10 * 1024 * 1024
ASSETS = Path(__file__).resolve().parents[1] / "assets" / "app"


def make_server(project, port=0):
    store = Store(project)
    session = secrets.token_urlsafe(32)
    cookie_name = "journal_session_" + store.project["id"].replace("-", "_")

    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalJournal"

        def log_message(self, format, *args):
            return

        def _valid_host(self):
            return self.headers.get("Host") == "127.0.0.1:" + str(self.server.server_address[1])

        def _authenticated(self):
            try:
                cookies = SimpleCookie(self.headers.get("Cookie", ""))
                return cookie_name in cookies and secrets.compare_digest(cookies[cookie_name].value, session)
            except Exception:
                return False

        def _reply(self, status, payload=None, *, content=None, mime="application/json; charset=utf-8", session_cookie=False):
            body = content if content is not None else (encoded(payload) + "\n").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("X-Frame-Options", "DENY")
            if session_cookie:
                self.send_header("Set-Cookie", cookie_name + "=" + session + "; HttpOnly; SameSite=Strict; Path=/")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self):
            if "application/json" not in self.headers.get("Content-Type", ""):
                raise ValueError("请求须为JSON")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                raise ValueError("请求大小不正确")
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict):
                raise ValueError("请求应为对象")
            return value

        def do_GET(self):
            if not self._valid_host():
                return self._reply(403, dict(error="仅允许本地地址访问"))
            resource = unquote(urlsplit(self.path).path)
            if resource.startswith("/api/") or resource.startswith("/images/"):
                if not self._authenticated():
                    return self._reply(401, dict(error="请先打开工作台首页"))
            try:
                if resource == "/health":
                    return self._reply(200, dict(ok=True, project_id=store.project["id"]))
                if resource == "/api/bootstrap":
                    return self._reply(200, store.bootstrap())
                if resource == "/api/state":
                    return self._reply(200, store.state())
                if resource == "/api/control":
                    return self._reply(200, store.progress())
                if resource == "/api/backups":
                    return self._reply(200, dict(backups=store.backups(), revision=store.state()["revision"]))
                if resource.startswith("/api/"):
                    return self._reply(404, dict(error="找不到接口"))
                if resource.startswith("/images/"):
                    base = store.path / "images"
                    relative = resource[len("/images/"):]
                else:
                    base = ASSETS
                    relative = "index.html" if resource == "/" else resource.lstrip("/")
                target = (base / relative).resolve()
                if base.resolve() not in target.parents or not target.is_file():
                    return self._reply(404, dict(error="找不到文件"))
                content = target.read_bytes()
                mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                return self._reply(200, content=content, mime=mime + ("; charset=utf-8" if mime.startswith("text/") or mime in {"application/javascript", "application/json"} else ""), session_cookie=resource in {"/", "/index.html"})
            except Exception:
                return self._reply(500, dict(error="读取项目失败，请保留项目备份"))

        do_HEAD = do_GET

        def _write(self):
            if not self._valid_host() or not self._authenticated():
                return self._reply(403, dict(error="请从工作台操作"))
            expected = "http://127.0.0.1:" + str(self.server.server_address[1])
            if self.headers.get("Origin") != expected:
                return self._reply(403, dict(error="拒绝跨站写入"))
            resource = urlsplit(self.path).path
            try:
                body = self._json()
                if resource == "/api/state" and self.command == "PUT":
                    return self._reply(200, store.save_user(body.get("user"), body.get("base_revision")))
                if resource == "/api/control" and self.command == "POST":
                    return self._reply(200, dict(ok=True, progress=store.control(body.get("action"))))
                if resource == "/api/backups/restore" and self.command == "POST":
                    result = store.restore(body.get("id"), body.get("base_revision"))
                    return self._reply(200, {**result, **store.state()})
                return self._reply(404, dict(error="找不到接口"))
            except RevisionConflict as error:
                return self._reply(409, dict(ok=False, error=str(error), **error.state))
            except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
                return self._reply(400, dict(ok=False, error=str(error)[:180]))
            except Exception:
                return self._reply(500, dict(ok=False, error="尚未保存成功，当前记录未主动清空"))

        do_PUT = _write
        do_POST = _write

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.store = store
    server.url = "http://127.0.0.1:" + str(server.server_address[1])
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="个人淘宝消费手账工作台")
    sub = parser.add_subparsers(dest="command", required=True)
    initialize = sub.add_parser("init")
    initialize.add_argument("--years", type=int, required=True)
    initialize.add_argument("--workspace", required=True)
    initialize.add_argument("--today")
    initialize.add_argument("--project-id")
    for name in ("serve", "status", "ingest", "progress", "reports", "archive", "restore", "export-user", "export"):
        command = sub.add_parser(name)
        command.add_argument("--project", required=True)
        if name == "serve":
            command.add_argument("--port", type=int, default=0)
        if name in {"ingest", "progress", "reports"}:
            command.add_argument("--input", required=True)
        if name in {"export-user", "export"}:
            command.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "init":
        result = init_project(args.workspace, args.years, args.today, args.project_id)
    elif args.command == "serve":
        server = make_server(args.project, args.port)
        atomic_json(server.store.path / "server.json", dict(pid=os.getpid(), url=server.url, project_id=server.store.project["id"]))
        print(encoded(dict(url=server.url, project_path=str(server.store.path), project_id=server.store.project["id"])), flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0
    else:
        store = Store(args.project)
        if args.command == "status":
            result = store.status()
        elif args.command in {"ingest", "progress", "reports"}:
            document = json.loads(Path(args.input).read_text(encoding="utf-8"))
            if args.command == "ingest":
                result = store.ingest(document)
            elif args.command == "progress":
                result = store.progress(document)
            else:
                store.set_reports(document)
                result = dict(ok=True)
        elif args.command == "export":
            atomic_json(Path(args.output), store.bootstrap())
            result = dict(ok=True, output=str(Path(args.output).resolve()))
        elif args.command == "export-user":
            from journal_store import utcnow
            state = store.state()
            atomic_json(Path(args.output), dict(format="spending-journal-backup", schemaVersion=3, exportedAt=utcnow(), user=state["user"]))
            result = dict(ok=True, output=str(Path(args.output).resolve()))
        else:
            result = store.archive_project(args.command == "archive")
    print(encoded(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(encoded(dict(ok=False, error=str(error)[:180])), file=sys.stderr)
        raise SystemExit(1)
