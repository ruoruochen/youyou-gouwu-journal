#!/usr/bin/env python3
"""Import observed Taobao exports or DOM snapshots; stdlib only, no account APIs.

Normal use is automated by collect.mjs. All private inputs and state stay in the
project directory. A generic 商品金额 column is deliberately not a paid price.
"""
from __future__ import annotations
import argparse, csv, hashlib, io, json, re, shutil, subprocess, sys, zipfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET

SCHEMA_VERSION = 1
CATEGORIES = ["服饰穿搭", "鞋包配饰", "美妆个护", "食品饮料", "医药健康", "3C数码", "家居日用", "家用电器", "图书文具", "运动户外", "旅游出行", "文娱爱好", "宠物用品", "母婴用品", "汽车用品", "虚拟服务", "充值储值", "待确认"]
CATEGORY_RULES = [
 ("充值储值", r"购物金.*(?:充值|储值)|(?:充值|储值).*购物金|话费充值|流量充值|加油卡充值|储值卡充值"),
 ("宠物用品", r"猫粮|狗粮|猫砂|宠物|猫窝|狗窝|逗猫|猫罐|狗罐|猫抓|宠物托运"),
 ("母婴用品", r"婴儿|宝宝|奶粉|纸尿裤|尿不湿|奶瓶|儿童安全座椅|孕妇|婴幼"),
 ("汽车用品", r"行车记录仪|汽车|车载|轮胎|雨刮|方向盘|车蜡|机油"),
 ("医药健康", r"药品|片剂|胶囊|创可贴|维生素|医用|体温计|血压计|血糖|布洛芬|感冒灵|氯雷他定|退热|口罩"),
 ("食品饮料", r"咖啡|奶茶|牛奶|酸奶|饮料|饼干|零食|巧克力|坚果|茶叶|果汁|可乐|矿泉水|面包|螺蛳粉|方便面|米粉|燕麦|香肠|火腿|牛肉|猪肉|鸡肉|水果|大米|食用油"),
 ("美妆个护", r"脱毛仪|护肤|面膜|面霜|乳液|精华|口红|唇膏|护手霜|洗发|护发|沐浴|洁面|防晒|眼霜|粉底|香水|眉笔|睫毛|身体乳|电动牙刷|牙膏|卫生巾|洗面|洗脸"),
 ("鞋包配饰", r"背包|书包|手提包|斜挎包|旅行箱|行李箱|运动鞋|跑步鞋|皮鞋|凉鞋|拖鞋|靴|板鞋|耳环|项链|手链|戒指|眼镜|墨镜|围巾|帽子|腰带"),
 ("服饰穿搭", r"睡衣|家居服|内衣|内裤|袜子|外套|大衣|风衣|羽绒|棉服|卫衣|针织|毛衣|衬衫|T恤|t恤|短袖|长袖|连衣裙|半身裙|长裤|短裤|牛仔|西装|羊毛|羊绒"),
 ("运动户外", r"泳镜|泳帽|泳衣|游泳|瑜伽|哑铃|健身|跳绳|羽毛球|乒乓球|篮球|足球|网球|冲浪|滑雪|骑行|帐篷|登山|露营|运动护|潜水"),
 ("3C数码", r"iPad|ipad|iPhone|iphone|平板|手机|电脑|笔记本|显示器|键盘|鼠标|耳机|蓝牙|充电器|充电宝|数据线|U盘|硬盘|相机|镜头|内存|显卡|打印机|MP3|mp3|数码"),
 ("家用电器", r"冰箱|空调|洗衣机|烘干机|电饭煲|电磁炉|电水壶|微波炉|烤箱|空气炸锅|吸尘器|扫地机器人|吹风机|电风扇|加湿器|除湿机|净水器|电视机"),
 ("图书文具", r"图书|书籍|教材|绘本|词典|小说|试卷|练习册|笔记本纸|中性笔|钢笔|铅笔|文具|文件夹|胶带|便利贴|手账本"),
 ("旅游出行", r"酒店|民宿|机票|火车票|高铁票|旅游|景区|门票|签证|接送机|租车|托运"),
 ("文娱爱好", r"专辑|唱片|周边|手办|模型|积木|拼图|吉他|钢琴|乐器|画笔|颜料|画板|桌游|盲盒|玩偶|玩具|游戏卡|cosplay"),
 ("家居日用", r"纸巾|抽纸|卷纸|湿巾|洗衣液|洗衣粉|清洁剂|垃圾袋|收纳|置物架|衣架|餐具|碗|盘子|杯子|水杯|保温杯|枕头|被子|被套|床单|四件套|毛巾|浴巾|窗帘|地毯|沙发|桌子|椅子|灯|插座|拖把|锅具"),
 ("虚拟服务", r"会员|视频年卡|网盘|软件|课程|在线|代练|游戏充值|电子书|虚拟|服务费|运费补差|补邮费"),
]
PHONE = re.compile(r"(?<!\d)(?:(?:\+?86|0086)[ \t-]?)?1[3-9](?:[ \t-]?\d){9}(?!\d)")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

def utcnow(): return datetime.now(timezone.utc).isoformat()
def sha(data): return hashlib.sha256(data).hexdigest()
def clean(value): return PHONE.sub("[手机号已脱敏]", str(value or "").strip())
def norm(value): return re.sub(r"\s+", " ", clean(value)).casefold()
def json_write(path, obj):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"); tmp.replace(path)
def money(value):
    if value is None or isinstance(value, bool) or value == "": return None
    s = str(value).replace(",", "").strip()
    m = re.fullmatch(r"(?:[¥￥]\s*)?(-?\d+(?:\.\d{1,4})?)\s*(?:元)?", s)
    if not m: return None
    try:
        d = Decimal(m[1])
        return float(d) if d.is_finite() and d >= 0 else None
    except InvalidOperation: return None

def labelled_money(text, labels):
    for label in labels:
        m = re.search(re.escape(label) + r"\s*[:：]?\s*[¥￥]?\s*(\d[\d,]*(?:\.\d+)?)", str(text or ""))
        if m: return money(m[1]), label
    return None, None

def quantity(value):
    if value is None or isinstance(value, bool): return None
    m = re.fullmatch(r"\s*(?:x|×|数量\s*[:：]?)?\s*([1-9]\d*)\s*(?:件|个)?\s*", str(value), re.I)
    return int(m[1]) if m else None

def date_value(value, excel=False):
    if value is None: return None
    s = str(value).strip()
    if excel:
        try:
            n = float(s)
            if 1 <= n <= 100000: return (datetime(1899, 12, 30) + timedelta(days=n)).strftime("%Y-%m-%d")
        except ValueError: pass
    m = re.search(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})", s)
    if not m: return None
    try: return datetime(*map(int, m.groups())).strftime("%Y-%m-%d")
    except ValueError: return None

def classify(name, existing=None):
    if existing and existing not in ("其他", "other", "待确认"): return existing
    for category, pattern in CATEGORY_RULES:
        if re.search(pattern, name or "", re.I): return category
    return "待确认"

def project_config(project):
    path = project / "project.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {}

def range_dates(config):
    scope = config.get("range", {})
    return (config.get("start_date") or config.get("range_start") or scope.get("start_date") or scope.get("start"),
            config.get("end_date") or config.get("range_end") or scope.get("end_date") or scope.get("end"))

def validate_project(project):
    project = Path(project).expanduser().resolve()
    skill = Path(__file__).resolve().parent.parent
    if project == skill or skill in project.parents:
        raise ValueError("私人项目必须位于Skill目录外，不能将订单或断点写入Skill安装包")
    project.mkdir(parents=True, exist_ok=True)
    return project

def save_raw(project, source):
    source = Path(source).resolve(); data = source.read_bytes(); digest = sha(data)
    if len(data) > 100 * 1024 * 1024: raise ValueError("导入文件过大（最大100MB），已停止，未截断数据")
    suffix = source.suffix.lower() if source.suffix.lower() in (".json", ".csv", ".xlsx") else ".bin"
    dest = project / "raw" / "imports" / (digest + suffix); dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if sha(dest.read_bytes()) != digest: raise ValueError("raw源文件哈希变化，停止导入")
    else:
        with dest.open("xb") as f: f.write(data)
        dest.chmod(0o600)
    return dest, digest

def xlsx_rows(path):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if len(infos) > 10000 or sum(i.file_size for i in infos) > 200 * 1024 * 1024:
            raise ValueError("XLSX展开体积异常，停止读取")
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            strings = ["".join(si.itertext()) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
        workbook = ET.fromstring(z.read("xl/workbook.xml")); rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
        sheet = workbook.find("m:sheets/m:sheet", NS)
        if sheet is None: raise ValueError("XLSX没有工作表")
        target = targets[sheet.attrib["{" + NS["r"] + "}id"]]
        member = target.lstrip("/") if target.startswith("/") else "xl/" + target
        rows = []
        for row in ET.fromstring(z.read(member)).findall("m:sheetData/m:row", NS):
            result = []
            for cell in row.findall("m:c", NS):
                column = re.match(r"[A-Z]+", cell.attrib.get("r", "A"))[0]
                index = 0
                for char in column: index = index * 26 + ord(char) - 64
                while len(result) < index: result.append("")
                typ = cell.attrib.get("t"); v = cell.find("m:v", NS)
                value = v.text if v is not None else ""
                if typ == "s": value = strings[int(value)] if value else ""
                elif typ == "inlineStr": value = "".join(cell.find("m:is", NS).itertext())
                elif typ == "b": value = "true" if value == "1" else "false"
                result[index - 1] = value or ""
            rows.append(result)
        return rows

def table_dicts(rows):
    rows = [r for r in rows if any(str(x).strip() for x in r)]
    if not rows: return []
    headers = [str(x).strip().lstrip("\ufeff") for x in rows[0]]
    if len(headers) != len(set(headers)): raise ValueError("表头重复，无法确认字段语义")
    return [dict(zip(headers, row + [""] * max(0, len(headers) - len(row)))) for row in rows[1:]]

def read_document(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".xlsx": return table_dicts(xlsx_rows(path)), "table"
    if suffix == ".csv":
        data = Path(path).read_bytes()
        for encoding in ("utf-8-sig", "gb18030"):
            try: text = data.decode(encoding); break
            except UnicodeDecodeError: continue
        else: raise ValueError("CSV编码无法识别")
        return table_dicts(list(csv.reader(io.StringIO(text)))), "table"
    if suffix == ".json":
        obj = json.loads(Path(path).read_text("utf-8-sig"))
        if isinstance(obj, list): return obj, "table"
        if isinstance(obj, dict) and isinstance(obj.get("orders"), list):
            return obj, "snapshot" if obj.get("capture_type") or obj.get("source_url") or obj.get("page") is not None else "canonical"
        if isinstance(obj, dict) and isinstance(obj.get("rows"), list): return obj["rows"], "table"
        raise ValueError("JSON缺少orders或rows")
    raise ValueError("支持JSON、CSV和XLSX")

def first(row, names):
    for name in names:
        value = row.get(name)
        if value is not None and value != "": return value, name
    return None, None

def item_base(row, evidence_file, index, source_type="table"):
    get = lambda names: first(row, names)
    name, _ = get(["name", "商品名称", "宝贝名称", "商品标题"])
    spec, _ = get(["spec", "型号款式", "规格", "商品规格", "SKU"])
    qty, qtykey = get(["qty", "quantity", "商品数量", "数量"])
    if qty is None: qty = row.get("quantity_text")
    name, spec, qty = clean(name), clean(spec), quantity(qty)
    product_url, _ = get(["product_url", "商品链接"])
    if not product_url:
        links = row.get("links") or []
        product_url = next((x.get("href") for x in links if x.get("href")), None)
    product_id, sku_id = row.get("product_id"), row.get("sku_id")
    if product_url:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(str(product_url)); q = parse_qs(parsed.query)
        if parsed.hostname and re.search(r"(^|\.)(taobao|tmall)\.com$", parsed.hostname):
            product_id = product_id or (q.get("id") or [None])[0]
            sku_id = sku_id or (q.get("skuId") or [None])[0]
            product_url = "https://item.taobao.com/item.htm?id=" + str(product_id) if product_id else None
        else: product_url = None
    category = classify(name, row.get("category"))
    unit, field = get(["unit_paid", "单件实付", "单件实付价", "单件实付款", "单价实付", "实付单价"])
    amount = money(unit); verified = amount is not None
    if source_type == "canonical": verified = bool(row.get("unit_paid_verified")) and amount is not None
    if source_type == "snapshot" and amount is not None: verified = row.get("unit_paid_verified") is True
    note = row.get("unit_paid_precision_note")
    row_paid = None
    if amount is None:
        actual, actualfield = get(["item_paid", "line_paid", "商品实付金额", "商品实付款", "实付价"])
        if actual is None and row.get("paid_text"):
            actual, actualfield = labelled_money(row["paid_text"], ["单件实付", "单价实付", "实付价", "商品实付"])
        row_paid = money(actual)
        if row_paid is not None:
            field = actualfield
            if actualfield in ("单件实付", "单价实付"):
                amount, verified = row_paid, True
            elif qty:
                quotient = Decimal(str(row_paid)) / qty
                if quotient == quotient.quantize(Decimal(".01")):
                    amount, verified = float(quotient), True
                else: note = "商品行实付款无法整分均分，保留行金额，不虚构单件价"
    reference, referencefield = get(["reference_price", "商品金额", "标价", "页面售价", "price"])
    reference = money(reference)
    if reference is None:
        prices = row.get("prices") or []
        reference = next((money(p.get("text")) for p in prices if money(p.get("text")) is not None), None)
    image_url, _ = get(["image_url", "商品图片"])
    if image_url and str(image_url).startswith("//"): image_url = "https:" + str(image_url)
    if image_url and not re.match(r"^https://[^/]+/", str(image_url)): image_url = None
    result = {"name":name, "spec":spec, "qty":qty, "source_index":index, "category":category,
        "kind":"clothes" if category == "服饰穿搭" else "big" if category in ("3C数码", "家用电器") else "other",
        "unit_paid":amount, "unit_paid_verified":verified,
        "unit_paid_recorded":amount is not None,
        "unit_paid_source":row.get("unit_paid_source") if source_type == "canonical" and verified and row.get("unit_paid_source") else ({"file":evidence_file,"field":field or "paid_text","description":"可见/导出明确商品实付字段；按已知数量换算单件"} if verified else None),
        "unit_paid_precision_note":note, "unit_net":money(row.get("unit_net")) if row.get("unit_net_verified") or row.get("price_verified") else None,
        "unit_net_verified":bool(row.get("unit_net_verified") or row.get("price_verified")), "price_verified":bool(row.get("unit_net_verified") or row.get("price_verified")), "price_source":row.get("price_source"), "line_paid":row_paid,
        "reference_price":reference, "reference_price_source":referencefield,
        "product_id":str(product_id) if product_id else None, "sku_id":str(sku_id) if sku_id else None,
        "product_url":product_url, "image_url":image_url, "image_file":row.get("image_file"),
        "image_scope":"item", "is_gift":bool(row.get("is_gift")), "is_virtual":category in ("虚拟服务", "充值储值"),
        "is_activity":bool(row.get("is_activity")),"is_metadata":bool(row.get("is_metadata")),"is_adjustment":bool(row.get("is_adjustment")),
        "quality_flags":list(row.get("quality_flags") or []), "legacy_keys":list(row.get("legacy_keys") or [])}
    if not name: result["quality_flags"].append("missing_name")
    if qty is None: result["quality_flags"].append("unknown_quantity")
    if not verified: result["quality_flags"].append("unverified_item_paid")
    if not image_url and not result["image_file"]: result["quality_flags"].append("missing_image")
    if category == "待确认": result["quality_flags"].append("category_pending")
    if row.get("item_id"): result["item_id"] = str(row["item_id"])
    return result

def stable_ids(order):
    seen = {}
    for item in order["items"]:
        identity = ("product|" + str(item["product_id"]) + "|sku|" + str(item["sku_id"]) if item.get("product_id") and item.get("sku_id") else "product|" + str(item["product_id"]) + "|spec|" + norm(item.get("spec")) if item.get("product_id") else "name|" + norm(item.get("name")) + "|spec|" + norm(item.get("spec")))
        seen[identity] = seen.get(identity, 0) + 1
        item.setdefault("item_id", "tb_" + sha((str(order["order_id"]) + "|" + identity + "|" + str(seen[identity])).encode())[:24])
        item["source_occurrence"] = seen[identity]

def normalize_document(document, mode, evidence_file, config=None):
    config = config or {}; orders = {}; problems = []
    if mode == "table":
        for index, row in enumerate(document, 2):
            oid, _ = first(row, ["order_id", "订单号", "订单编号", "主订单编号"])
            if not oid: problems.append({"row":index,"reason":"missing_order_id"}); continue
            oid = str(oid).strip().lstrip("'")
            day, _ = first(row, ["date", "订单提交时间", "订单创建时间", "创建时间", "下单时间"])
            day = date_value(day, excel=True)
            status, _ = first(row, ["status", "订单状态", "交易状态"])
            shop, _ = first(row, ["shop", "店铺名称", "卖家店铺"])
            paid, paidkey = first(row, ["paid", "实付金额", "订单实付款", "订单实付金额"])
            paid = money(paid)
            order = orders.setdefault(oid, {"order_id":oid,"date":day,"shop":clean(shop),"status":clean(status),"paid":paid,"paid_verified":paid is not None,"paid_source":{"file":evidence_file,"field":paidkey,"description":"订单级实付款，与商品实付分开保存"} if paid is not None else None,"items":[]})
            order["items"].append(item_base(row,evidence_file,index))
    else:
        for index, source in enumerate(document["orders"]):
            oid = source.get("order_id")
            if not oid: problems.append({"row":index,"reason":"missing_order_id"}); continue
            paid = money(source.get("paid")); paid_verified = bool(source.get("paid_verified")) and paid is not None
            if not paid_verified and source.get("payment_text"):
                paid, label = labelled_money(source["payment_text"], ["实付款", "实付金额", "实际付款", "实付"])
                paid_verified = paid is not None
            order = {"order_id":str(oid), "date":date_value(source.get("date")),"shop":clean(source.get("shop")), "status":clean(source.get("status")),
                "paid":paid,"paid_verified":paid_verified,"paid_source":{"file":evidence_file,"field":"payment_text" if source.get("payment_text") else "paid","description":"订单级实付，不替代单件实付"} if paid_verified else None,
                "refund":money(source.get("refund")) if source.get("refund_verified") else None,"refund_verified":bool(source.get("refund_verified")),
                "net":money(source.get("net")) if source.get("net_verified") else None,"net_verified":bool(source.get("net_verified")),
                "items":[item_base(item,evidence_file,j,mode) for j,item in enumerate(source.get("items") or [])]}
            orders[order["order_id"]] = order
    lower, upper = range_dates(config); included=[]
    for order in orders.values():
        stable_ids(order)
        order["is_recharge"] = bool(order["items"]) and all(i["category"] == "充值储值" for i in order["items"])
        order["category"] = order["items"][0]["category"] if len(set(i["category"] for i in order["items"])) == 1 else "混合订单"
        for item in order["items"]:
            if item.get("qty") is None: problems.append({"order_id":order["order_id"],"item_id":item["item_id"],"reason":"unknown_quantity"})
        order["source_file"] = evidence_file
        order["is_status_unknown"] = norm(order.get("status")) in ("", "未知", "待核", "待确认", "unknown")
        if order["is_status_unknown"]: problems.append({"order_id":order["order_id"],"reason":"missing_status"})
        if not order["date"]:
            problems.append({"order_id":order["order_id"],"reason":"missing_date"}); continue
        if order["date"] and ((lower and order["date"] < lower) or (upper and order["date"] > upper)): continue
        included.append(order)
    coverage = [{"month":month,"state":"partial","source":"observed_import"} for month in sorted({o["date"][:7] for o in included if o["date"]})]
    return {"orders":included,"coverage":coverage,"meta":{"schema_version":SCHEMA_VERSION,"source_file":evidence_file,"imported_at":utcnow(),"money_policy":"explicit_item_paid_only","quality_queue":problems}}

def reconcile_existing(normalized, existing_orders):
    """Keep the first observed identity across export/DOM source enrichment.

    Explicit product/SKU differences prove separate goods. A unique same-order
    title/spec match may enrich a source lacking product ids. Ambiguous matches
    are queued, never turned into an additional billable item.
    """
    existing = {str(o["order_id"]):o for o in existing_orders}
    for order in normalized["orders"]:
        previous = existing.get(order["order_id"])
        if not previous: continue
        old_items = previous.get("items", []); used = set(); retained = []
        for item in order["items"]:
            exact = [old for old in old_items if old.get("item_id") == item["item_id"] and old["item_id"] not in used]
            candidates = exact
            uncertain = []
            if not candidates:
                for old in old_items:
                    if old.get("item_id") in used: continue
                    a,b = item.get("product_id"),old.get("product_id")
                    x,y = item.get("sku_id"),old.get("sku_id")
                    if a and b and a != b or x and y and x != y: continue
                    spec_a,spec_b = norm(item.get("spec")),norm(old.get("spec"))
                    if a and b and a == b and (x and y and x == y or spec_a == spec_b):
                        candidates.append(old); continue
                    name_a,name_b = norm(item.get("name")),norm(old.get("name"))
                    if name_a == name_b and (spec_a == spec_b or not spec_a or not spec_b):
                        candidates.append(old); continue
                    short_a,short_b = re.sub(r"(?:\.\.\.|…)\s*$", "",name_a),re.sub(r"(?:\.\.\.|…)\s*$", "",name_b)
                    if (short_a != name_a or short_b != name_b) and min(len(short_a),len(short_b)) >= 6 and (short_a.startswith(short_b) or short_b.startswith(short_a)) and (spec_a == spec_b or not spec_a or not spec_b):
                        uncertain.append(old)
            if len(candidates) > 1:
                occurrence = [old for old in candidates if old.get("source_occurrence") == item.get("source_occurrence")]
                if len(occurrence) == 1: candidates = occurrence
            if len(candidates) == 1:
                old = candidates[0]; used.add(old["item_id"])
                aliases = [*old.get("legacy_keys", []),*item.get("legacy_keys", [])]
                if item["item_id"] != old["item_id"]: aliases.append(item["item_id"])
                item["item_id"] = old["item_id"]; item["legacy_keys"] = list(dict.fromkeys(aliases))
            elif candidates or uncertain:
                normalized["meta"]["quality_queue"].append({"order_id":order["order_id"],"item_id":item["item_id"],"reason":"ambiguous_item_identity","source_name":item["name"],"source_spec":item["spec"]})
                continue
            retained.append(item)
        order["items"] = retained
    return normalized

def import_file(project, source, ingest=True, output=None):
    project = validate_project(project); raw, digest = save_raw(project,source)
    document, mode = read_document(raw)
    normalized = normalize_document(document,mode,str(raw.relative_to(project)),project_config(project))
    if (project / "journal.sqlite").exists():
        from journal_store import Store
        normalized = reconcile_existing(normalized,Store(project).data()["orders"])
    normalized["meta"]["source_sha256"] = digest
    out = Path(output).resolve() if output else project / "checkpoints" / "batches" / (digest + ".normalized.json")
    if project not in out.parents: raise ValueError("归一化输出必须保存在项目内")
    json_write(out,normalized)
    result = {"state":"imported","source_sha256":digest,"normalized":str(out),"orders":len(normalized["orders"]),"items":sum(len(o["items"]) for o in normalized["orders"]),"pending_items":sum(not i["unit_paid_verified"] for o in normalized["orders"] for i in o["items"]),"quality_issues":len(normalized["meta"]["quality_queue"])}
    if ingest:
        backend = Path(__file__).with_name("journal.py")
        if not backend.exists(): raise RuntimeError("journal.py缺失：归一化数据已保存，但尚未入账")
        proc = subprocess.run([sys.executable,"-B",str(backend),"ingest","--project",str(project),"--input",str(out)],capture_output=True,text=True)
        if proc.returncode: raise RuntimeError("入账失败，原件和批次已保存：" + proc.stderr[-600:])
        try: result["ingest"] = json.loads(proc.stdout)
        except json.JSONDecodeError: result["ingest"] = {"ok":True}
    return result

def finalize_coverage(project):
    """Close only a proven contiguous traversal. Price completeness stays separate."""
    project = validate_project(project)
    checkpoint = json.loads((project / "checkpoints" / "collection.json").read_text("utf-8"))
    if not (checkpoint.get("completed") and checkpoint.get("saw_first_page") and checkpoint.get("contiguous", True)
            and checkpoint.get("coverage_boundary") in ("start_date_reached", "true_last_page", "true_empty")):
        raise ValueError("没有从第一页连续走到真实边界的证明，不能标记完整覆盖")
    from journal_store import Store, TERMINAL
    store = Store(project); data = store.data(); config = store.project
    month = config["range_start"][:7]; last = config["range_end"][:7]; coverage = []
    issues = checkpoint.get("quality_issue_count", 0)
    while month <= last:
        orders = [o for o in data["orders"] if o["date"].startswith(month)]
        eligible = [i for o in orders if o.get("status", "").strip() not in TERMINAL and not o.get("is_recharge")
                    for i in o.get("items", []) if not any(i.get(k) for k in ("is_gift", "is_virtual", "is_activity", "is_metadata", "is_adjustment"))]
        missing = sum(not (i.get("unit_paid_verified") is True and type(i.get("unit_paid")) in (int, float) and i["unit_paid"] >= 0 and i.get("qty")) for i in eligible)
        state = "partial" if missing or issues else "complete" if orders else "empty"
        coverage.append(dict(month=month,state=state,source_complete=True,pending_items=missing,
            reason="已按时间连续遍历到边界；实付未核与来源异常单独保留"))
        year, number = map(int,month.split("-")); month = f"{year + (number == 12):04d}-{number % 12 + 1:02d}"
    document = {"orders":[],"coverage":coverage,"meta":{"source_complete":True,"collection_complete":True,
        "collection_boundary":checkpoint["coverage_boundary"],"status_complete":not any(o.get("is_status_unknown") or not o.get("status") for o in data["orders"]),"paid_coverage_complete":not issues and all(c["state"] != "partial" for c in coverage)}}
    out = project / "checkpoints" / "boundary.json"; json_write(out,document)
    return store.ingest(document)

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--project",required=True); parser.add_argument("--file"); parser.add_argument("--finalize-coverage",action="store_true")
    parser.add_argument("--no-ingest",action="store_true",help="仅用于开发校验"); parser.add_argument("--output")
    args=parser.parse_args()
    try:
        if args.finalize_coverage: result = finalize_coverage(args.project)
        elif args.file: result = import_file(args.project,args.file,not args.no_ingest,args.output)
        else: parser.error("需要--file或--finalize-coverage")
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"state":"error","error":str(exc)},ensure_ascii=False),file=sys.stderr); return 1
    return 0
if __name__ == "__main__": raise SystemExit(main())
