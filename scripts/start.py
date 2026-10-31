#!/usr/bin/env python3
"""Create/resume an isolated journal and launch its loopback workbench."""
from __future__ import annotations

import argparse
from datetime import date
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

from journal_store import Store, atomic_json, init_project


ROOT = Path(__file__).resolve().parents[1]


def doctor():
    return {
        "python": sys.version.split()[0],
        "sqlite": __import__("sqlite3").sqlite_version,
        "node": shutil.which("node"),
        "ego_browser": shutil.which("ego-browser"),
        "workbench_ready": (ROOT / "assets" / "app" / "index.html").is_file(),
        "note": "浏览器由助手按当前环境的浏览器技能连接；不需要用户运行命令。",
    }


def healthy(project, metadata):
    try:
        address = urlsplit(metadata["url"])
        if address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port or address.path not in ("", "/"):
            return False
        with build_opener(ProxyHandler({})).open(metadata["url"].rstrip("/") + "/health", timeout=1) as response:
            body = json.load(response)
        return body.get("ok") is True and body.get("project_id") == project["id"]
    except (OSError, ValueError, KeyError):
        return False


def start_server(project_path):
    store = Store(project_path)
    marker = store.path / "server.json"
    if marker.is_file():
        try:
            previous = json.loads(marker.read_text(encoding="utf-8"))
            if healthy(store.project, previous):
                return {**previous, "reused_server": True}
        except (OSError, ValueError):
            pass
    with (store.path / "workbench.log").open("ab") as log:
        process = subprocess.Popen(
            [sys.executable, "-B", str(ROOT / "scripts" / "journal.py"), "serve", "--project", str(store.path)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
            cwd=str(store.path), env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("工作台未能启动；请由助手检查项目内 workbench.log。")
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            if metadata.get("pid") == process.pid and healthy(store.project, metadata):
                return {**metadata, "reused_server": False}
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    process.terminate()
    raise RuntimeError("工作台启动超时；项目与数据已保留。")


def main():
    parser = argparse.ArgumentParser(description="自动准备独立的消费手账")
    parser.add_argument("--years", type=int, default=10)
    parser.add_argument("--workspace", default=str(Path.cwd()))
    parser.add_argument("--project")
    parser.add_argument("--new", action="store_true", help="切换账号或另建分析时使用")
    parser.add_argument("--today", help=argparse.SUPPRESS)
    parser.add_argument("--doctor", action="store_true")
    args = parser.parse_args()
    if args.doctor:
        print(json.dumps(doctor(), ensure_ascii=False))
        return
    workspace = Path(args.workspace).expanduser().resolve()
    if workspace == ROOT or ROOT in workspace.parents:
        raise ValueError("请由助手选择技能目录外的当前工作区，不把个人数据写进技能包。")
    marker = workspace / ".youyou-taobao-journal" / "active.json"
    project_path = Path(args.project).expanduser().resolve() if args.project else None
    reused = bool(project_path)
    if project_path is None and marker.is_file() and not args.new:
        try:
            saved = json.loads(marker.read_text(encoding="utf-8"))
            candidate = Path(saved["project_path"]).resolve()
            metadata = json.loads((candidate / "project.json").read_text(encoding="utf-8"))
            if metadata.get("years") == args.years and metadata.get("range_end") == (args.today or date.today().isoformat()) and not metadata.get("archived"):
                project_path, reused = candidate, True
        except (ValueError, OSError, KeyError):
            pass
    if project_path is None:
        initialized = init_project(workspace, args.years, args.today)
        project_path = Path(initialized["project_path"])
    store = Store(project_path)
    if store.project.get("archived"):
        raise ValueError("项目已归档；请先由助手恢复项目或另建分析。")
    metadata = start_server(project_path)
    atomic_json(marker, {"project_path": str(project_path), "project_id": store.project["id"]})
    print(json.dumps({"ok": True, "project_path": str(project_path), "project_id": store.project["id"], "range_start": store.project["range_start"], "range_end": store.project["range_end"], "advice_year": store.project["advice_year"], "url": metadata["url"], "reused_project": reused, "next": "助手打开工作台，并按浏览器技能创建或接回采集空间；用户只需登录。", "runtime": doctor()}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
