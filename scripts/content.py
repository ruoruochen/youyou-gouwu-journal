#!/usr/bin/env python3
"""Small, source-bound fact packs for the host assistant; no extra model key."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from journal_store import Store, atomic_json, utcnow, reportable_order


PRIVATE = re.compile(r"医药|处方|药品|避孕|私密|内衣|内裤|卫生巾|验孕|保健品|维生素|蛋白粉|乳清|身份证|手机号|诊断|病历")
TERMINAL = {"交易关闭", "已退款", "退款成功", "退款完成"}


def facts(store, selected=None):
    data = store.data()
    months = {}
    for order in data["orders"]:
        if not reportable_order(order):
            continue
        month = order["date"][:7]
        if selected and month != selected:
            continue
        bucket = months.setdefault(month, {"month": month, "facts": [], "_categories": set(), "_seen": set()})
        for item in order.get("items", []):
            name = str(item.get("name", ""))
            if not name or PRIVATE.search(name) or item.get("category") == "医药健康" or any(item.get(key) for key in ("is_gift", "is_activity", "is_metadata", "is_adjustment")):
                continue
            key = (order["order_id"], item["item_id"])
            if key in bucket["_seen"]:
                continue
            category = str(item.get("category") or "日常小物")
            if len(bucket["facts"]) >= 3 or (category in bucket["_categories"] and len(bucket["facts"]) >= 2):
                continue
            bucket["_seen"].add(key)
            bucket["_categories"].add(category)
            ref = "f" + hashlib.sha256((str(key[0]) + ":" + str(key[1])).encode()).hexdigest()[:12]
            short = re.sub(r"\d{11,}|https?://\S+", "", name)[:56]
            bucket["facts"].append({"ref": ref, "name": short, "category": category, "order_id": key[0], "item_id": key[1]})
    public, mapping = [], {}
    for month, record in sorted(months.items()):
        rows = []
        for fact in record["facts"]:
            mapping[fact["ref"]] = {"month": month, "order_id": fact["order_id"], "item_id": fact["item_id"]}
            rows.append({key: fact[key] for key in ("ref", "name", "category")})
        public.append({"month": month, "facts": rows})
    return {"data_version": data["meta"]["data_version"], "months": public, "instruction": "按 references/content.md 为每月写100—220字幸福小文章，输出 monthly 映射；每篇 text + fact_refs。只写购买记录支持的事实，不编造使用经历、动机、关系或健康结论。"}, mapping


def apply(store, source):
    current, mapping = facts(store)
    if source.get("data_version") != current["data_version"]:
        raise ValueError("数据已有更新，请重新生成小事实包后合并月报。")
    allowed = {entry["month"] for entry in current["months"]}
    draft = source.get("monthly")
    if not isinstance(draft, dict) or not draft:
        raise ValueError("月报需要非空 monthly 映射。")
    overlay_path = store.path / "reports" / "automatic.json"
    output = {"data_version": current["data_version"], "monthly": {}, "annual": {}}
    if overlay_path.is_file():
        previous = json.loads(overlay_path.read_text(encoding="utf-8"))
        if previous.get("data_version") == current["data_version"]:
            output.update(previous)
    for month, report in draft.items():
        if month not in allowed or not isinstance(report, dict):
            raise ValueError("月报月份超出当前已记录范围。")
        text = report.get("text")
        if not isinstance(text, str) or not 20 <= len(text.strip()) <= 1600 or "<script" in text.lower():
            raise ValueError("月报正文应为20—1600字纯文字。")
        refs = report.get("fact_refs", [])
        if not isinstance(refs, list) or any(ref not in mapping or mapping[ref]["month"] != month for ref in refs):
            raise ValueError("月报引用不是本月小事实包中的记录。")
        available = [key for key, value in mapping.items() if value["month"] == month]
        if available and not refs:
            raise ValueError("有可用商品事实的月份，需要至少引用一项。")
        output["monthly"][month] = {"title": month + "的小幸福", "text": text.strip(), "source_order_ids": list(dict.fromkeys(mapping[ref]["order_id"] for ref in refs)), "source_item_ids": list(dict.fromkeys(mapping[ref]["item_id"] for ref in refs)), "fact_refs": refs, "generated_at": utcnow(), "data_version": current["data_version"], "generator": "host-assistant"}
    atomic_json(overlay_path, output)
    return {"ok": True, "updated_months": sorted(draft), "total_months": len(output["monthly"]), "data_version": current["data_version"]}


def main():
    parser = argparse.ArgumentParser(description="自动生成幸福月报所需的小事实包")
    parser.add_argument("command", choices=("facts", "apply"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--output")
    parser.add_argument("--input")
    parser.add_argument("--month")
    args = parser.parse_args()
    store = Store(args.project)
    if args.command == "facts":
        result, _ = facts(store, args.month)
        if args.output:
            atomic_json(Path(args.output), result)
            result = {"ok": True, "output": str(Path(args.output).resolve()), "months": len(result["months"]), "data_version": result["data_version"]}
    else:
        if not args.input:
            parser.error("apply requires --input")
        result = apply(store, json.loads(Path(args.input).read_text(encoding="utf-8")))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
