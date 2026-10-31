"""Private project persistence. Standard library only; no platform credentials."""
from __future__ import annotations

import calendar
from contextlib import contextmanager
import hashlib
import json
import os
import re
import sqlite3
import uuid
from datetime import date, datetime, timezone
from pathlib import Path


SCHEMA = 1
USER_FIELDS = ("junk_labels", "orphan_labels", "monthly_notes", "kind_overrides", "category_overrides", "price_overrides", "price_override_archives", "report_archives", "report_archive_events")
TERMINAL = {"交易关闭", "已退款", "退款成功", "退款完成"}


def status_unknown(order):
    value = str(order.get("status") or "").strip()
    return order.get("is_status_unknown") is True or not value or bool(re.search(r"未知|待核|未采集", value))


def reportable_order(order):
    return not status_unknown(order) and str(order.get("status") or "").strip() not in TERMINAL and not order.get("is_recharge")


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("x", encoding="utf-8") as stream:
        stream.write(encoded(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def default_user():
    return dict(schemaVersion=3, junk_labels={}, orphan_labels={}, monthly_notes={}, advice_todo=[], advice_selected=[], kind_overrides={}, category_overrides={}, price_overrides={}, price_override_archives={}, report_archives={}, report_archive_events={})


def assert_json(value, depth=0):
    if depth > 25:
        raise ValueError("记录嵌套过深")
    if isinstance(value, dict):
        if any(key in {"__proto__", "prototype", "constructor"} for key in value):
            raise ValueError("记录包含不支持的字段")
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("记录字段名必须为文字")
            assert_json(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            assert_json(item, depth + 1)
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        raise ValueError("记录必须为JSON")
    encoded(value)


def validate_user(user):
    assert_json(user)
    if not isinstance(user, dict) or user.get("schemaVersion", 3) != 3:
        raise ValueError("不支持的个人记录版本")
    for field in USER_FIELDS:
        if not isinstance(user.get(field, {}), dict):
            raise ValueError(field + "格式不正确")
    for field in ("advice_todo", "advice_selected"):
        if not isinstance(user.get(field, []), list):
            raise ValueError(field + "格式不正确")
    for label in user.get("junk_labels", {}).values():
        if not isinstance(label, dict) or label.get("status") not in {"low", "ok", "todo"}:
            raise ValueError("使用标签格式不正确")
        quantity = label.get("lowQty", label.get("low_qty"))
        if quantity is not None and (type(quantity) is not int or quantity < (1 if label["status"] == "low" else 0)):
            raise ValueError("低频数量格式不正确")
    for record in user.get("price_overrides", {}).values():
        if not isinstance(record, dict) or type(record.get("unit_net")) not in (int, float) or record["unit_net"] < 0:
            raise ValueError("个人价格修正格式不正确")
    for todo in user.get("advice_todo", []):
        if not isinstance(todo, dict) or not isinstance(todo.get("text"), str):
            raise ValueError("任务格式不正确")
        if todo.get("month") and (not isinstance(todo["month"], str) or not re.fullmatch(r"(?:\d{4}-(0[1-9]|1[0-2])|全年|按需|(?:[1-9]|1[0-2])月)", todo["month"])):
            raise ValueError("任务月份格式不正确")
    merged = default_user()
    merged.update(user)
    merged["schemaVersion"] = 3
    return merged


class RevisionConflict(Exception):
    def __init__(self, state):
        self.state = state
        super().__init__("记录已在其他窗口更新，请先合并")


def init_project(workspace, years, today=None, project_id=None):
    if type(years) is not int or not 1 <= years <= 100:
        raise ValueError("年份应为1—100的整数")
    cutoff = date.fromisoformat(today) if today else date.today()
    first = cutoff.replace(year=cutoff.year - years, day=min(cutoff.day, calendar.monthrange(cutoff.year - years, cutoff.month)[1]))
    identifier = project_id or "journal-" + uuid.uuid4().hex[:12]
    if not re.fullmatch(r"[a-z][a-z0-9-]{3,63}", identifier):
        raise ValueError("项目标识格式不正确")
    workspace = Path(workspace).expanduser().resolve()
    skill = Path(__file__).resolve().parents[1]
    if workspace == skill or skill in workspace.parents:
        raise ValueError("个人项目应保存在技能目录之外")
    project = workspace / "taobao-journal" / identifier
    if (project / "project.json").exists():
        raise ValueError("项目已存在，请直接打开该项目")
    project.mkdir(parents=True, exist_ok=False)
    for name in ("raw", "images", "checkpoints", "reports", "backups"):
        (project / name).mkdir()
    metadata = dict(id=identifier, title=f"我的{years}年消费手账", years=years, range_start=first.isoformat(), range_end=cutoff.isoformat(), advice_year=cutoff.year + 1, created_at=utcnow(), archived=False, schema_version=SCHEMA)
    atomic_json(project / "project.json", metadata)
    store = Store(project)
    return {"project_path": str(project), "project_id": identifier, **metadata}


def _nonnull_merge(old, new):
    result = dict(old)
    for key, value in new.items():
        if value is not None and not (value == "" and old.get(key)):
            result[key] = value
    # List-page refreshes often omit payment details. They cannot downgrade
    # a prior detail-page observation, or replace paid amounts with list prices.
    for amount, verified, companions in (
        ("unit_paid", "unit_paid_verified", ("unit_paid_source", "unit_paid_recorded", "unit_paid_precision_note")),
        ("unit_net", "price_verified", ("price_source",)),
        ("paid", "paid_verified", ("paid_source",)),
        ("refund", "refund_verified", ("refund_source",)),
    ):
        fresh = new.get(amount)
        fresh_money = type(fresh) in (int, float) and fresh >= 0
        prior_verified = old.get(verified) is True and type(old.get(amount)) in (int, float)
        if amount in old and (not fresh_money or (prior_verified and new.get(verified) is not True)):
            for field in (amount, verified, *companions):
                if field in old:
                    result[field] = old[field]
                else:
                    result.pop(field, None)
    for field in ("legacy_keys", "quality_flags"):
        if isinstance(old.get(field), list) and isinstance(new.get(field), list):
            result[field] = list({encoded(value): value for value in [*old[field], *new[field]]}.values())
    return result


class Store:
    def __init__(self, project):
        self.path = Path(project).expanduser().resolve()
        metadata = self.path / "project.json"
        if not metadata.is_file():
            raise ValueError("找不到项目，请先初始化")
        self.project = json.loads(metadata.read_text(encoding="utf-8"))
        if not re.fullmatch(r"[a-z][a-z0-9-]{3,63}", self.project.get("id", "")):
            raise ValueError("项目标识不正确")
        self.database = self.path / "journal.sqlite"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY,date TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS user_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reports(kind TEXT NOT NULL,period TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,period));
            """)
            db.execute("INSERT OR IGNORE INTO user_state VALUES(1,0,?)", (encoded(default_user()),))
            for key, value in {"data_revision": 0, "data_updated_at": self.project["created_at"], "coverage": [], "meta": {}, "pending_counts": {"pending_count": 0, "pending_order_count": 0}, "progress": {"run_state": "ready", "pending_count": 0, "paused": False, "completed": False}}.items():
                db.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", (key, encoded(value)))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(str(self.database), timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=10000")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _get(db, key, fallback=None):
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else fallback

    @staticmethod
    def _set(db, key, value):
        db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (key, encoded(value)))

    def state(self, db=None):
        if db is None:
            with self.connect() as connection:
                return self.state(connection)
        row = db.execute("SELECT revision,payload FROM user_state WHERE id=1").fetchone()
        return dict(user=json.loads(row["payload"]), revision=row["revision"])

    def _snapshot(self, db, state):
        identifier = "backup-" + uuid.uuid4().hex
        at = utcnow()
        payload = dict(format="spending-journal-backup", schemaVersion=3, exportedAt=at, user=state["user"], revision=state["revision"])
        filename = self.path / "backups" / (identifier + ".json")
        atomic_json(filename, payload)
        db.execute("INSERT INTO snapshots VALUES(?,?,?,?)", (identifier, state["revision"], at, encoded(payload)))
        return identifier

    def save_user(self, user, base_revision):
        user = validate_user(user)
        if type(base_revision) is not int or base_revision < 0:
            raise ValueError("请提供当前记录版本")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            state = self.state(db)
            if state["revision"] != base_revision:
                raise RevisionConflict(state)
            backup = self._snapshot(db, state)
            revision = base_revision + 1
            db.execute("UPDATE user_state SET revision=?,payload=? WHERE id=1", (revision, encoded(user)))
        return dict(ok=True, revision=revision, backup_id=backup)

    def backups(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT id,revision,created_at FROM snapshots ORDER BY created_at DESC")]

    def restore(self, identifier, base_revision):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM snapshots WHERE id=?", (identifier,)).fetchone()
        if not row:
            raise ValueError("找不到这份历史记录")
        return self.save_user(json.loads(row[0])["user"], base_revision)

    def progress(self, update=None):
        with self.connect() as db:
            if update is not None:
                db.execute("BEGIN IMMEDIATE")
            current = self._get(db, "progress", {})
            if update is not None:
                if not isinstance(update, dict):
                    raise ValueError("进度格式不正确")
                assert_json(update)
                current.update(update)
                current["updated_at"] = utcnow()
                self._set(db, "progress", current)
            current.update(self._get(db, "pending_counts", {"pending_count": 0, "pending_order_count": 0}))
        return current

    def _pending_counts(self, db):
        count, order_count = 0, 0
        for row in db.execute("SELECT payload FROM orders WHERE date>=? AND date<=?", (self.project["range_start"], self.project["range_end"])):
            order = json.loads(row[0])
            if order.get("is_recharge") or str(order.get("status", "")).strip() in TERMINAL:
                continue
            pending = [item for item in order.get("items", [])
                       if not any(item.get(key) for key in ("is_gift", "is_virtual", "is_activity", "is_metadata", "is_adjustment"))
                       and (status_unknown(order) or not (item.get("unit_paid_verified") is True and type(item.get("unit_paid")) in (int, float) and item["unit_paid"] >= 0 and type(item.get("qty")) is int and item["qty"] > 0))]
            count += len(pending)
            order_count += bool(pending)
        return dict(pending_count=count, pending_order_count=order_count)

    def control(self, action):
        if action == "pause":
            return self.progress(dict(paused=True, run_state="paused_by_user"))
        if action == "resume":
            return self.progress(dict(paused=False, run_state="ready"))
        raise ValueError("不支持的操作")

    def ingest(self, document):
        assert_json(document)
        if not isinstance(document, dict) or not isinstance(document.get("orders"), list):
            raise ValueError("采集结果应包含orders列表")
        if not isinstance(document.get("coverage", []), list) or not isinstance(document.get("meta", {}), dict):
            raise ValueError("覆盖记录或采集元信息格式不正确")
        payload = (encoded(document) + "\n").encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        source_path = self.path / "raw" / ("normalized-" + digest + ".json")
        if not source_path.exists():
            with source_path.open("xb") as stream:
                stream.write(payload)
        changed = 0
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing_item_owners = {}
            for row in db.execute("SELECT order_id,payload FROM orders"):
                for item in json.loads(row["payload"]).get("items", []):
                    existing_item_owners[item["item_id"]] = row["order_id"]
            for order in document["orders"]:
                if not isinstance(order, dict):
                    raise ValueError("订单格式不正确")
                identifier = str(order.get("order_id") or "")
                if not identifier or len(identifier) > 128:
                    raise ValueError("订单缺少稳定标识")
                when = str(order.get("date", ""))
                date.fromisoformat(when)
                if not isinstance(order.get("items", []), list):
                    raise ValueError("商品列表格式不正确")
                normalized, occurrences, seen = [], {}, set()
                for source in order.get("items", []):
                    if not isinstance(source, dict):
                        raise ValueError("商品格式不正确")
                    item = dict(source)
                    identity = str(source.get("name", "")) + "\0" + str(source.get("spec", ""))
                    occurrences[identity] = occurrences.get(identity, 0) + 1
                    stable = str(source.get("item_id") or "item-" + hashlib.sha256((identifier + "\0" + identity + "\0" + str(occurrences[identity])).encode()).hexdigest()[:24])
                    if stable in seen or len(stable) > 200:
                        raise ValueError("同一订单的商品标识重复或过长")
                    seen.add(stable)
                    if stable in existing_item_owners and existing_item_owners[stable] != identifier:
                        raise ValueError("商品标识与另一订单冲突")
                    existing_item_owners[stable] = identifier
                    item.update(item_id=stable)
                    item.setdefault("legacy_keys", [])
                    normalized.append(item)
                incoming = {**order, "order_id": identifier, "date": when, "items": normalized}
                previous = db.execute("SELECT payload FROM orders WHERE order_id=?", (identifier,)).fetchone()
                old = json.loads(previous[0]) if previous else {}
                merged = _nonnull_merge(old, incoming)
                old_items = {item["item_id"]: item for item in old.get("items", [])}
                order_ids = list(old_items)
                for item in normalized:
                    stable = item["item_id"]
                    if stable not in old_items:
                        order_ids.append(stable)
                    old_items[stable] = _nonnull_merge(old_items.get(stable, {}), item)
                merged["items"] = [old_items[key] for key in order_ids]
                text = encoded(merged)
                if not previous or previous[0] != text:
                    db.execute("INSERT OR REPLACE INTO orders VALUES(?,?,?)", (identifier, when, text))
                    changed += 1
            old_coverage = self._get(db, "coverage", [])
            coverage = {entry["month"]: entry for entry in old_coverage if isinstance(entry, dict) and entry.get("month")}
            for entry in document.get("coverage", []):
                if not isinstance(entry, dict) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", str(entry.get("month", ""))):
                    raise ValueError("月份覆盖格式不正确")
                previous = coverage.get(entry["month"], {})
                # A partial incremental batch cannot erase a previously confirmed complete month.
                if previous.get("state") == "complete" and entry.get("state") not in {"complete", "empty"}:
                    entry = {**entry, **previous}
                coverage[entry["month"]] = {**previous, **entry}
            new_coverage = [coverage[key] for key in sorted(coverage)]
            new_meta = _nonnull_merge(self._get(db, "meta", {}), document.get("meta", {}))
            if changed or new_coverage != old_coverage or new_meta != self._get(db, "meta", {}):
                self._set(db, "data_revision", self._get(db, "data_revision", 0) + 1)
                self._set(db, "data_updated_at", utcnow())
            self._set(db, "coverage", new_coverage)
            self._set(db, "meta", new_meta)
            self._set(db, "pending_counts", self._pending_counts(db))
        return dict(ok=True, changed_orders=changed, source_sha256=digest, **self.status())

    def data(self):
        with self.connect() as db:
            orders = [json.loads(row[0]) for row in db.execute("SELECT payload FROM orders WHERE date>=? AND date<=? ORDER BY date DESC,order_id", (self.project["range_start"], self.project["range_end"]))]
            revision = self._get(db, "data_revision", 0)
            stored = self._get(db, "meta", {})
            meta = {**stored, "schema_version": 3, "project_id": self.project["id"], "title": self.project["title"], "years": self.project["years"], "range_start": self.project["range_start"], "range_end": self.project["range_end"], "advice_year": self.project["advice_year"], "data_version": self.project["id"] + ":" + str(revision), "updated_at": self._get(db, "data_updated_at")}
            coverage = {row["month"]: row for row in self._get(db, "coverage", [])}
        start = date.fromisoformat(self.project["range_start"]).replace(day=1)
        last = date.fromisoformat(self.project["range_end"]).replace(day=1)
        month = start
        while month <= last:
            key = month.strftime("%Y-%m")
            if key not in coverage:
                has_data = any(order["date"].startswith(key) for order in orders)
                coverage[key] = dict(month=key, state="partial" if has_data else "unknown", reason="已取得部分记录，尚未证明整月完整。" if has_data else "尚未确认这个月的记录。")
            month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
        return dict(meta=meta, orders=orders, coverage=[coverage[key] for key in sorted(coverage) if self.project["range_start"][:7] <= key <= self.project["range_end"][:7]])

    def set_reports(self, reports):
        assert_json(reports)
        with self.connect() as db:
            for kind in ("monthly", "annual"):
                for period, report in reports.get(kind, {}).items():
                    if not isinstance(report, dict) or not isinstance(report.get("text"), str):
                        raise ValueError("报告格式不正确")
                    db.execute("INSERT OR REPLACE INTO reports VALUES(?,?,?)", (kind, str(period), encoded(report)))

    def reports(self, data=None):
        data = data or self.data()
        output = dict(monthly={}, annual={})
        with self.connect() as db:
            for row in db.execute("SELECT kind,period,payload FROM reports"):
                output.setdefault(row["kind"], {})[row["period"]] = json.loads(row["payload"])
        automatic = self.path / "reports" / "automatic.json"
        if automatic.is_file():
            try:
                overlay = json.loads(automatic.read_text(encoding="utf-8"))
                if overlay.get("data_version") == data["meta"]["data_version"]:
                    for kind in ("monthly", "annual"):
                        for period, report in overlay.get(kind, {}).items():
                            if isinstance(report, dict) and isinstance(report.get("text"), str):
                                output[kind][str(period)] = report
            except (ValueError, OSError, AttributeError):
                pass  # An interrupted optional article export cannot hide the journal.
        months = sorted({order["date"][:7] for order in data["orders"] if reportable_order(order)})
        private = re.compile(r"医药|处方|药品|避孕|私密|内衣|内裤|卫生巾|验孕|保健品|维生素|蛋白粉|乳清|身份证|手机号")
        for month in months:
            if month in output["monthly"]:
                continue
            orders = [order for order in data["orders"] if order["date"].startswith(month) and reportable_order(order)]
            chosen = []
            for order in orders:
                for item in order.get("items", []):
                    name = str(item.get("name", ""))
                    if not name or item.get("is_gift") or item.get("is_activity") or item.get("is_metadata") or item.get("is_adjustment") or item.get("category") == "医药健康" or private.search(name):
                        continue
                    if not any(entry[1]["name"] == name for entry in chosen):
                        chosen.append((order, item))
                    if len(chosen) == 3:
                        break
                if len(chosen) == 3:
                    break
            names = ["「" + str(item["name"])[:24] + ("…" if len(str(item["name"])) > 24 else "") + "」" for _, item in chosen]
            lead = "翻开" + str(int(month[5:])) + "月的购物记录，" + "、".join(names) + "在这一页碰了面。" if names else "翻开这个月的记录，给普通日子留一页小小的回看。"
            text = lead + "有些小幸福，就藏在这些不起眼的日常名字里。\n\n清单记下了买到什么，真正的生活还在清单之外。哪个已经成了心头好，哪个暂时在角落等出场，都可以慢慢补上属于你的故事。\n\n这个月也辛苦啦。愿留下来的东西，能陪你把普通日子过得舒展一点。"
            output["monthly"][month] = dict(title=month + "的小幸福", text=text, generated_at=data["meta"]["updated_at"], data_version=data["meta"]["data_version"], source_order_ids=list(dict.fromkeys(order["order_id"] for order, _ in chosen)), source_item_ids=[item["item_id"] for _, item in chosen], generator="local-rules")
        return output

    def bootstrap(self):
        data = self.data()
        return dict(project=self.project, data=data, reports=self.reports(data), **self.state(), progress=self.progress())

    def status(self):
        data = self.data()
        state = self.state()
        progress = self.progress()
        return dict(project_path=str(self.path), project_id=self.project["id"], orders=len(data["orders"]), items=sum(len(order.get("items", [])) for order in data["orders"]), data_version=data["meta"]["data_version"], user_revision=state["revision"], pending_count=progress["pending_count"], pending_order_count=progress["pending_order_count"], progress=progress)

    def archive_project(self, archived):
        self.project["archived"] = bool(archived)
        self.project["updated_at"] = utcnow()
        atomic_json(self.path / "project.json", self.project)
        return self.project
