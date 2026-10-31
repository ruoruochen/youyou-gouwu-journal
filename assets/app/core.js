/* Pure data rules and reversible local user records. No network or order-data writes. */
(function (global) {
  "use strict";
  const KEY = typeof global.JOURNAL_STORAGE_KEY === "string" && /^shouzhang_v2_qa_[a-z0-9_]+$/.test(global.JOURNAL_STORAGE_KEY) ? global.JOURNAL_STORAGE_KEY : "shouzhang_v2";
  const RAW_BACKUP_KEY = KEY + "_original_raw_backup";
  const adviceYear = String(global.JOURNAL_PROJECT && global.JOURNAL_PROJECT.advice_year || new Date().getFullYear() + 1);
  const data = typeof ORDERS_DATA !== "undefined" ? ORDERS_DATA : { meta: {}, orders: [], coverage: [] };
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const categories = ["服饰穿搭", "鞋包配饰", "美妆个护", "食品饮料", "医药健康", "3C数码", "家居日用", "家用电器", "图书文具", "运动户外", "旅游出行", "文娱爱好", "宠物用品", "虚拟服务", "充值储值", "待确认"];
  const defaults = () => ({ schemaVersion: 3, junk_labels: {}, orphan_labels: {}, monthly_notes: {}, advice_todo: [], advice_selected: [], kind_overrides: {}, category_overrides: {}, price_overrides: {}, price_override_archives: {}, report_archives: {}, report_archive_events: {} });
  const status = { readError: null, writeError: null, storageBlocked: false, storageAvailable: true, dirty: false, savedAt: null, migrationWarning: null, message: "本机保存就绪" };
  const listeners = new Set();
  const prepared = new WeakMap();
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const number = n => typeof n === "number" && Number.isFinite(n);
  const moneyValue = n => number(n) && n >= 0;
  const clone = o => JSON.parse(JSON.stringify(o));
  let lastTick = 0;
  const now = () => { lastTick = Math.max(Date.now(), lastTick + 1); return new Date(lastTick).toISOString(); };
  const sumMoney = arr => arr.reduce((s, v) => s + Math.round(v * 100), 0) / 100;
  const quantity = it => Number.isInteger(it.qty) && it.qty > 0 ? it.qty : 1;
  const stamp = o => Date.parse(o && (o.updated_at || o.at || o.created_at) || "") || 0;
  const safeError = e => String(e && (e.message || e.name) || e || "未知错误").slice(0, 180);
  const uid = prefix => prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  function assertJSON(value, depth) {
    depth = depth || 0;
    if (depth > 25) throw new Error("备份嵌套过深");
    if (value === null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("备份含非法数字"); return; }
    if (typeof value !== "object") throw new Error("备份只能包含 JSON 数据");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("备份含非普通对象");
    Object.keys(value).forEach(k => {
      if (["__proto__", "prototype", "constructor"].includes(k)) throw new Error("备份含非法字段");
      assertJSON(value[k], depth + 1);
    });
  }
  const items = [];
  const byId = new Map();
  const legacyMap = new Map();
  orders.forEach(order => (order.items || []).forEach((item, idx) => {
    const id = String(item.item_id || order.order_id + "|" + idx);
    if (byId.has(id)) return;
    const flat = { ...item, id, item_id: id, order };
    Object.defineProperty(flat, "effectiveUnitNet", { enumerable: true, get: () => priceFor(id).value });
    Object.defineProperty(flat, "effectivePriceVerified", { enumerable: true, get: () => priceFor(id).verified });
    items.push(flat); byId.set(id, flat);
    const keys = Array.isArray(item.legacy_keys) ? item.legacy_keys : [order.order_id + "|" + idx];
    keys.forEach(k => {
      const key = String(k);
      if (!legacyMap.has(key)) legacyMap.set(key, id);
      else if (legacyMap.get(key) !== id) legacyMap.set(key, null);
    });
  }));
  function recordHistory(previous) {
    if (!previous) return [];
    const prior = clone(previous); delete prior.history; delete prior.versions;
    return [...(Array.isArray(previous.history) ? previous.history : []), prior].slice(-100);
  }
  function validateUser(source) {
    if (!plain(source)) throw new Error("用户记录必须是对象");
    if (source.schemaVersion !== undefined && (!Number.isInteger(source.schemaVersion) || source.schemaVersion > 3 || source.schemaVersion < 1)) throw new Error("不支持此备份版本");
    ["junk_labels", "orphan_labels", "monthly_notes", "kind_overrides", "category_overrides", "price_overrides", "price_override_archives", "report_archives", "report_archive_events"].forEach(k => {
      if (has(source, k) && !plain(source[k])) throw new Error(k + " 格式不正确");
    });
    ["advice_todo", "advice_selected"].forEach(k => { if (has(source, k) && !Array.isArray(source[k])) throw new Error(k + " 格式不正确"); });
    Object.entries(source.junk_labels || {}).forEach(([id, label]) => {
      if (!plain(label) || !["low", "ok", "todo"].includes(label.status)) throw new Error("商品标签格式不正确：" + id);
      const q = label.lowQty === undefined ? label.low_qty : label.lowQty;
      if (q !== undefined && (!Number.isInteger(q) || q < (label.status === "low" ? 1 : 0))) throw new Error("低频数量格式不正确");
      if (label.note !== undefined && typeof label.note !== "string") throw new Error("标签备注格式不正确");
    });
    Object.entries(source.monthly_notes || {}).forEach(([month, note]) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !plain(note) || typeof note.text !== "string") throw new Error("月报格式不正确");
    });
    Object.values(source.kind_overrides || {}).forEach(v => {
      if (!["clothes", "big", "other"].includes(typeof v === "string" ? v : v && v.kind)) throw new Error("商品类型格式不正确");
    });
    Object.values(source.category_overrides || {}).forEach(v => {
      if (!plain(v) || !categories.includes(v.category) || (v.archived !== undefined && typeof v.archived !== "boolean") || (v.note !== undefined && typeof v.note !== "string")) throw new Error("本人品类格式不正确");
    });
    Object.values(source.price_overrides || {}).forEach(v => { if (!plain(v) || !moneyValue(v.unit_net) || (v.note !== undefined && typeof v.note !== "string")) throw new Error("核对价格格式不正确"); });
    Object.values(source.price_override_archives || {}).forEach(v => { if (!Array.isArray(v) || v.some(x => !plain(x) || typeof x.cleared_at !== "string")) throw new Error("价格撤销记录格式不正确"); });
    (source.advice_todo || []).forEach(t => {
      if (!plain(t) || typeof t.text !== "string" || (t.id !== undefined && typeof t.id !== "string") || (t.done !== undefined && typeof t.done !== "boolean")) throw new Error("待办格式不正确");
      if (t.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(t.month)) {
        if (!/^(全年|按需|\d{1,2}月)$/.test(t.month)) throw new Error("待办月份格式不正确");
      }
    });
    if ((source.advice_selected || []).some(id => typeof id !== "string")) throw new Error("建议选择格式不正确");
  }
  function migratedUser(source) {
    validateUser(source);
    const u = { ...defaults(), ...clone(source), schemaVersion: 3 };
    const labels = {}, orphans = { ...u.orphan_labels };
    Object.entries(u.junk_labels).forEach(([oldKey, label]) => {
      const id = byId.has(oldKey) ? oldKey : legacyMap.get(oldKey);
      if (!id) { orphans[oldKey] = { ...label, legacy_key: oldKey }; return; }
      const it = byId.get(id);
      const migrated = { ...label, lowQty: label.status === "low" ? (label.lowQty === undefined ? (label.low_qty === undefined ? quantity(it) : label.low_qty) : label.lowQty) : 0, archived: !!label.archived };
      if (has(label, "amount")) migrated.legacy_amount = label.amount;
      if (oldKey !== id) migrated.legacy_key = oldKey;
      if (!labels[id] || stamp(migrated) > stamp(labels[id])) labels[id] = migrated;
      if (migrated.lowQty > quantity(it)) migrated.quantity_pending = true;
    });
    u.junk_labels = labels; u.orphan_labels = orphans;
    u.advice_todo = u.advice_todo.map((t, idx) => ({ ...t, id: t.id || "legacy_todo_" + idx + "_" + hash(t.text + "|" + (t.month || "")), month: /^\d{1,2}月$/.test(t.month || "") ? adviceYear + "-" + t.month.replace("月", "").padStart(2, "0") : /^(全年|按需)$/.test(t.month || "") ? "" : t.month || "", schedule_hint: t.schedule_hint || (/^(全年|按需)$/.test(t.month || "") ? t.month : ""), done: !!t.done, archived: !!t.archived }));
    u.advice_selected = [...new Set(u.advice_selected)];
    return u;
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
  let storage = null, originalRaw = null, user = defaults();
  try {
    storage = global.JOURNAL_STORAGE;
    if (!storage) throw new Error("项目存储尚未就绪");
    originalRaw = storage.getItem(KEY);
    if (originalRaw) {
      const source = JSON.parse(originalRaw); assertJSON(source);
      user = migratedUser(source);
      if (source.schemaVersion !== 3) status.migrationWarning = "已在内存兼容旧记录，原始记录将在首次保存前保留副本";
    }
  } catch (e) {
    status.readError = safeError(e); status.storageBlocked = true; status.storageAvailable = false;
    status.message = "本机记录暂不能读取，原记录未覆盖；本次编辑可导出备份";
  }
  function emit() { listeners.forEach(fn => { try { fn(status); } catch (_) {} }); }
  function save() {
    status.dirty = true;
    if (status.storageBlocked || !storage) { emit(); return false; }
    try {
      if (originalRaw && storage.getItem(RAW_BACKUP_KEY) === null) storage.setItem(RAW_BACKUP_KEY, originalRaw);
      storage.setItem(KEY, JSON.stringify(user));
      status.writeError = null; status.storageAvailable = true; status.dirty = !!storage.asynchronous; status.savedAt = storage.asynchronous ? null : now(); status.message = storage.asynchronous ? "正在保存到本机项目…" : "已保存到本机项目";
      emit(); return true;
    } catch (e) {
      status.writeError = safeError(e); status.storageAvailable = false;
      status.message = "本机保存失败，本次编辑仍在页面内，请导出备份"; emit(); return false;
    }
  }
  function requireItem(id) { const it = byId.get(String(id)); if (!it) throw new Error("找不到这件商品"); return it; }
  function priceFor(id) {
    const it = byId.get(String(id)); if (!it) return { value: null, verified: false, source: "" };
    const correction = user.price_overrides[id];
    if (correction && moneyValue(correction.unit_net)) return { value: correction.unit_net, verified: true, source: "本人核对", note: correction.note || "" };
    if (it.price_verified === true && moneyValue(it.unit_net)) return { value: it.unit_net, verified: true, source: it.price_source || "订单数据" };
    return { value: null, verified: false, source: it.price_source || "价格待核验" };
  }
  function itemPriceDisplay(id) {
    const it = requireItem(id), order = it.order;
    if (it.unit_paid_verified === true && moneyValue(it.unit_paid)) {
      return { value: it.unit_paid, label: "单件实付", source: it.unit_paid_source || "已核验单件实付；退款后净额另核", verified: true, pending: false, sourceKind: "unit_paid" };
    }
    if (it.unit_paid_recorded === true && moneyValue(it.unit_paid) && it.unit_paid_source) {
      return { value: it.unit_paid, label: "单件实付（订单记录）", source: it.unit_paid_source, verified: false, pending: false, sourceKind: "recorded_unit_paid" };
    }
    if ((order.items || []).length === 1 && it.qty === 1 && !isNoise(it) && order.paid_verified === true && moneyValue(order.paid) && order.paid > 0 && order.shipping === 0) {
      return { value: order.paid, label: "单件实付", source: "已核验订单实付（单商品单件、运费为0）；退款后净额另核", verified: true, pending: false, sourceKind: "order_paid" };
    }
    const net = priceFor(id);
    if (net.verified) return { value: net.value, label: "单件净实付", source: net.source, verified: true, pending: false, sourceKind: "unit_net" };
    return { value: null, label: "单件实付待核", source: "没有已核验的单件实付或净实付，不以页面售价代替", verified: false, pending: true, sourceKind: "pending" };
  }
  function junkPriceFor(id) {
    const it = requireItem(id), net = priceFor(id);
    if (net.verified) return { ...net, sourceKind: "unit_net", label: "单件净实付" };
    const precisionPending = String(it.unit_paid_precision_note || "").trim() !== "";
    if (!precisionPending && it.unit_paid_verified === true && moneyValue(it.unit_paid) && Math.abs(it.unit_paid * 100 - Math.round(it.unit_paid * 100)) < 1e-7) {
      return { value: it.unit_paid, verified: true, source: it.unit_paid_source, sourceKind: "unit_paid", label: "单件实付（退款后净额待核）" };
    }
    return { value: null, verified: false, sourceKind: "pending", label: "单件金额待核", reason: precisionPending ? "单价显示精度待核" : "单件实付待核验" };
  }
  function kindFor(id) {
    const it = requireItem(id), v = user.kind_overrides[id];
    if (v) return typeof v === "string" ? v : v.kind;
    const name = String(it.name || "");
    const careDevice = /脱毛仪|脱毛机|美容仪/.test(name) && !/配件|替换头|灯头|灯管|滤光片|保护套|收纳包|导入液|凝胶|面膜|充电器|充电线|电源适配器|(?:适用|适配|兼容|用于).{0,20}(?:脱毛仪|脱毛机|美容仪)/.test(name);
    if ((!it.kind || it.kind === "other") && careDevice) return "big";
    if (["clothes", "big", "other"].includes(it.kind)) return it.kind;
    if (/电脑|手机|冰箱|洗衣机|电视|床垫|沙发|跑步机|ipad|笔记本|相机/i.test(it.name || "")) return "big";
    if (/衣|裤|裙|t恤|外套|卫衣|牛仔|羽绒服|大衣|衫/i.test(it.name || "")) return "clothes";
    return "other";
  }
  function categoryFor(id) {
    const it = requireItem(id), correction = user.category_overrides[id];
    return correction && !correction.archived ? correction.category : it.category || "待确认";
  }
  function orderCategoryFor(order) {
    if (order.is_recharge) return "充值储值";
    const values = new Set((order.items || []).filter(it => !it.is_gift && !it.is_adjustment && !it.is_metadata && it.category_vote !== false).map(it => categoryFor(it.item_id || it.id)));
    if (!values.size || values.has("待确认")) return "待确认";
    return values.size > 1 ? "混合订单" : [...values][0];
  }
  function setCategory(id, category, note) {
    const it = requireItem(id);
    if (!categories.includes(category)) throw new Error("请选择有效的消费品类");
    if (category === "充值储值" && !it.order.is_recharge) throw new Error("储值用途需按原订单证据核对，不能只靠改品类转移现金流");
    const previous = user.category_overrides[id];
    user.category_overrides[id] = { category, note: String(note || ""), archived: false, source: "本人核对", updated_at: now(), history: recordHistory(previous) };
    save(); return categoryFor(id);
  }
  function archiveCategory(id, archived) {
    requireItem(id); const previous = user.category_overrides[id];
    if (!previous) return categoryFor(id);
    user.category_overrides[id] = { ...previous, archived: !!archived, updated_at: now(), history: recordHistory(previous) };
    save(); return categoryFor(id);
  }
  function isNoise(it) {
    const name = String(it.name || "").trim();
    return it.is_gift || it.is_virtual || it.is_adjustment || it.is_metadata || it.order.is_recharge || /^(?:运费险|申请开票|垫付|保险服务|含运费|交易快照|购物金|充值|预存)[\s:：¥￥\d.,元]*$/.test(name) || /^(?:￥\s*)?\d+\.\d+$/.test(name);
  }
  function isClosedOrder(order) {
    return ["交易关闭", "已退款", "退款成功", "退款完成"].includes(String(order && order.status || "").trim());
  }
  function isStatusUnknown(order) {
    if (isClosedOrder(order)) return false;
    const value = String(order && order.status || "").trim().toLowerCase();
    return !value || !!(order && order.is_status_unknown === true) || ["未知", "状态未知", "待核", "状态待核", "unknown"].includes(value);
  }
  function archiveOrders(filter) {
    const f = filter || {}, query = String(f.q || "").toLowerCase();
    return orders.filter(order => (f.includeClosed || !isClosedOrder(order))
      && (!order.is_recharge || f.cat === "充值储值")
      && (!f.year || order.date.startsWith(f.year))
      && (!f.month || order.date.slice(5, 7) === f.month)
      && (!f.cat || orderCategoryFor(order) === f.cat)
      && (!query || [order.shop, ...(order.items || []).map(it => it.name + " " + (it.spec || ""))].join(" ").toLowerCase().includes(query)));
  }
  function candidates() {
    const seen = new Set(), result = [];
    items.forEach(it => {
      if (isClosedOrder(it.order) || isStatusUnknown(it.order) || it.order.is_recharge) return;
      if (seen.has(it.id)) return; seen.add(it.id);
      const label = user.junk_labels[it.id], tagged = !!label && ["low", "ok"].includes(label.status);
      const kind = kindFor(it.id), threshold = kind === "clothes" ? 300 : kind === "big" ? 500 : null;
      const p = junkPriceFor(it.id), zeroOrder = it.order.net_verified === true && it.order.net === 0;
      const excluded = !!isNoise(it) || zeroOrder || threshold === null;
      const belowThreshold = threshold !== null && p.verified && p.value <= threshold;
      const eligible = !excluded && p.verified && p.value > threshold;
      const unknownPrice = !excluded && !p.verified;
      const recordedPaid = moneyValue(it.unit_paid) && (it.unit_paid_verified === true || (it.unit_paid_recorded === true && !!it.unit_paid_source)) ? it.unit_paid : null;
      const upperPrice = recordedPaid === null ? it.sell_price : recordedPaid;
      const knownUpperBelow = unknownPrice && moneyValue(upperPrice) && upperPrice <= threshold;
      if (!tagged && (excluded || belowThreshold || knownUpperBelow)) return;
      const quantityPending = !Number.isInteger(it.qty) || it.qty < 1 || !!(label && label.status === "low" && (label.quantity_pending || (label.lowQty || label.low_qty || 1) > quantity(it)));
      result.push({ ...it, kind, threshold, effectiveUnitNet: p.sourceKind === "unit_net" ? p.value : null, investmentUnitAmount: p.value, amountBasis: p.sourceKind, amountLabel: p.label, unitPrice: p.value, priceVerified: p.verified, isEligible: eligible && !quantityPending, pricePending: unknownPrice, quantityPending, belowThreshold, excluded, pendingReason: quantityPending ? "购买／低频数量需重新核对" : excluded ? "该商品不计入门槛统计" : belowThreshold ? "单件金额未达门槛，不计金额" : unknownPrice ? p.reason : "", multi: (it.order.items || []).filter(x => !x.is_gift && !x.is_virtual).length > 1 });
    });
    return result;
  }
  function labelFor(id) { return user.junk_labels[id] || null; }
  function setLabel(id, state, lowQty, note) {
    const it = requireItem(id), key = String(id), prev = labelFor(key);
    const stateValue = state === null || state === "clear" ? "todo" : state;
    if (!["low", "ok", "todo"].includes(stateValue)) throw new Error("使用状态不正确");
    const q = stateValue === "low" ? (lowQty === undefined ? quantity(it) : Number(lowQty)) : 0;
    if (!Number.isInteger(q) || q < (stateValue === "low" ? 1 : 0) || q > quantity(it)) throw new Error("低频数量应在1与商品数量之间");
    user.junk_labels[key] = { ...(prev || {}), status: stateValue, lowQty: q, note: note === undefined ? prev && prev.note || "" : String(note), archived: false, quantity_pending: false, at: now(), updated_at: now(), history: recordHistory(prev) };
    save(); return user.junk_labels[key];
  }
  function archiveLabel(id, archived) {
    requireItem(id); const prev = labelFor(id); if (!prev) return null;
    user.junk_labels[id] = { ...prev, archived: !!archived, at: now(), updated_at: now(), history: recordHistory(prev) }; save(); return user.junk_labels[id];
  }
  function setKind(id, kind) {
    requireItem(id); if (!["clothes", "big", "other"].includes(kind)) throw new Error("商品类型不正确");
    const prev = user.kind_overrides[id]; user.kind_overrides[id] = { kind, at: now(), updated_at: now(), history: plain(prev) ? recordHistory(prev) : [] }; save(); return kind;
  }
  function setPrice(id, value, note) {
    requireItem(id); if (value === null) return clearPrice(id);
    if (!moneyValue(value) || Math.round(value * 100) / 100 !== value) throw new Error("单件净实付须为非负金额，最多两位小数");
    const prev = user.price_overrides[id];
    user.price_overrides[id] = { unit_net: value, note: String(note || ""), at: now(), updated_at: now(), source: "本人核对", history: recordHistory(prev) }; save(); return priceFor(id);
  }
  function clearPrice(id) {
    requireItem(id); const prev = user.price_overrides[id];
    if (prev) {
      user.price_override_archives = user.price_override_archives || {};
      user.price_override_archives[id] = [...(user.price_override_archives[id] || []), { ...clone(prev), cleared_at: now() }];
      delete user.price_overrides[id]; save();
    }
    return priceFor(id);
  }
  function junkStats() {
    const all = candidates(), todo = [], low = [], ok = [], pending = [], archived = [], amounts = [];
    const candidateAmounts = [], candidatePaidAmounts = [], candidateNetAmounts = [], lowPaidAmounts = [], lowNetAmounts = [];
    let lowPendingCount = 0, lowQty = 0;
    all.forEach(it => {
      if (it.isEligible) {
        const amount = it.investmentUnitAmount * it.qty;
        candidateAmounts.push(amount);
        (it.amountBasis === "unit_paid" ? candidatePaidAmounts : candidateNetAmounts).push(amount);
      }
      const l = labelFor(it.id);
      if (l && l.status === "low") {
        const q = l.lowQty === undefined ? (l.low_qty === undefined ? quantity(it) : l.low_qty) : l.lowQty;
        lowQty += q;
        if (it.isEligible) {
          const amount = it.investmentUnitAmount * q;
          amounts.push(amount);
          (it.amountBasis === "unit_paid" ? lowPaidAmounts : lowNetAmounts).push(amount);
        }
        else if (it.pricePending || it.quantityPending) lowPendingCount++;
      }
      if (l && l.archived) { archived.push(it); return; }
      if (!l || l.status === "todo") todo.push(it);
      else if (l.status === "low") low.push(it);
      else if (l.status === "ok") ok.push(it);
      if (it.pricePending || it.quantityPending) pending.push(it);
    });
    const confirmedAmount = sumMoney(amounts);
    return { all, todo, low, ok, pending, archived, candidateAmount: sumMoney(candidateAmounts), candidateVerifiedCount: candidateAmounts.length, candidatePaidAmount: sumMoney(candidatePaidAmounts), candidateNetAmount: sumMoney(candidateNetAmounts), lowPaidAmount: sumMoney(lowPaidAmounts), lowNetAmount: sumMoney(lowNetAmounts), lowVerifiedCount: amounts.length, confirmedAmount, lowAmount: confirmedAmount, lowPendingCount, lowQty, pendingCount: pending.length, orphanCount: Object.keys(user.orphan_labels).length };
  }
  function goodsStats(list) {
    // Consumption amount only: parent payment/net remain separate diagnostics.
    const rows = (Array.isArray(list) ? list : orders).filter(o => !o.is_recharge && !isClosedOrder(o) && !isStatusUnknown(o));
    const financialRows = order => (order.items || []).filter(it => !it.is_activity && !it.is_metadata);
    // Unknown/free supplementary gifts do not establish a payment or block a
    // known purchase. A claimed nonzero gift payment must still be verified.
    const paymentRows = order => financialRows(order).filter(it => !it.is_gift ||
      (!(moneyValue(it.unit_paid) && it.unit_paid === 0) && (it.unit_paid_verified === true || it.unit_paid_recorded === true || (moneyValue(it.unit_paid) && it.unit_paid > 0))));
    const hasPrecisionNote = it => it.unit_paid_precision_note !== null && it.unit_paid_precision_note !== undefined && String(it.unit_paid_precision_note).trim() !== "";
    const formalRolePayment = it => it.unit_paid_recorded === true && plain(it.unit_paid_source) &&
      typeof it.unit_paid_source.file === "string" && it.unit_paid_source.file.trim() !== "" &&
      typeof it.unit_paid_source.field === "string" && /(?:^|[.\]])unit_paid$/.test(it.unit_paid_source.field) &&
      typeof it.unit_paid_source.description === "string" && it.unit_paid_source.description.trim() !== "";
    const verifiedPayment = it => !hasPrecisionNote(it) && it.unit_paid_verified === true && moneyValue(it.unit_paid) &&
      Math.abs(it.unit_paid * 100 - Math.round(it.unit_paid * 100)) < 1e-7 && Number.isInteger(it.qty) && it.qty > 0 &&
      (!(it.is_adjustment || it.is_gift) || formalRolePayment(it));
    const amountOrders = rows.filter(order => financialRows(order).length), precisionOrders = amountOrders.filter(order => paymentRows(order).some(hasPrecisionNote));
    // Never use parent J, net, displayed prices or an empty every() as payment.
    const complete = amountOrders.filter(order => paymentRows(order).length > 0 && paymentRows(order).every(verifiedPayment));
    const coveredItems = complete.flatMap(paymentRows), allMainItems = amountOrders.flatMap(paymentRows);
    return { goodsActiveOrderCount: rows.length, goodsPaidVerified: sumMoney(coveredItems.map(it => it.unit_paid * it.qty)), goodsPaidVerifiedCount: complete.length,
      goodsPaidOrderCount: amountOrders.length, goodsPaidPendingCount: amountOrders.length - complete.length,
      goodsPaidPrecisionPendingCount: precisionOrders.length,
      goodsPaidVerifiedItemRows: coveredItems.length, goodsPaidItemRows: allMainItems.length,
      goodsPaidPendingItemRows: allMainItems.length - coveredItems.length };
  }
  function stats(list) {
    const rows = Array.isArray(list) ? list : orders, knownStatus = rows.filter(o => !isStatusUnknown(o)), consume = knownStatus.filter(o => !o.is_recharge), rechargeOrders = knownStatus.filter(o => o.is_recharge);
    const paidOrders = consume.filter(o => moneyValue(o.paid)), verifiedPaid = consume.filter(o => o.paid_verified === true && moneyValue(o.paid));
    const verified = consume.filter(o => o.net_verified === true && moneyValue(o.net)), verifiedRecharge = rechargeOrders.filter(o => o.paid_verified === true && moneyValue(o.paid));
    return { orders: consume.length, count: consume.length, recordCount: rows.length, statusPendingCount: rows.length - knownStatus.length, ...goodsStats(rows),
      paid: sumMoney(paidOrders.map(o => o.paid)), paidAll: sumMoney(knownStatus.filter(o => moneyValue(o.paid)).map(o => o.paid)), paidCount: paidOrders.length, paidPendingCount: consume.length - paidOrders.length, paidVerified: sumMoney(verifiedPaid.map(o => o.paid)), paidVerifiedCount: verifiedPaid.length, paidUnverifiedCount: consume.length - verifiedPaid.length, netVerified: sumMoney(verified.map(o => o.net)), verifiedCount: verified.length, pendingCount: consume.length - verified.length, recharge: sumMoney(rechargeOrders.filter(o => moneyValue(o.paid)).map(o => o.paid)), rechargeCount: rechargeOrders.length, rechargeVerified: sumMoney(verifiedRecharge.map(o => o.paid)), rechargeVerifiedCount: verifiedRecharge.length, itemCount: consume.reduce((s, o) => s + (o.items || []).filter(it => !it.is_gift && !it.is_activity && !it.is_virtual && !it.is_adjustment && !it.is_metadata).length, 0), quantity: consume.reduce((s, o) => s + (o.items || []).filter(it => !it.is_gift && !it.is_activity && !it.is_virtual && !it.is_adjustment && !it.is_metadata).reduce((n, it) => n + quantity(it), 0), 0) };
  }
  function monthValid(month) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(month); }
  function getNote(month) { return user.monthly_notes[month] || null; }
  function saveNote(month, text) {
    if (!monthValid(month) || typeof text !== "string" || text.length > 100000) throw new Error("月报月份或正文不正确");
    const prev = getNote(month), versions = prev ? [...(prev.versions || []), { text: prev.text, at: prev.updated_at || prev.at || "", archived: !!prev.archived }].slice(-100) : [];
    user.monthly_notes[month] = { ...(prev || {}), text, at: now(), updated_at: now(), archived: false, versions };
    delete user.report_archives[month]; save(); return getNote(month);
  }
  function archiveNote(month, archived) {
    if (!monthValid(month)) throw new Error("月报月份不正确");
    const prev = getNote(month), at = now();
    if (prev) user.monthly_notes[month] = { ...prev, archived: !!archived, updated_at: at };
    user.report_archive_events[month] = { archived: !!archived, at, updated_at: at };
    if (archived) user.report_archives[month] = { at }; else delete user.report_archives[month];
    save(); return getNote(month) || user.report_archives[month] || null;
  }
  function getTodos(filter) {
    filter = filter || {};
    return user.advice_todo.filter(t => (filter.archived === undefined ? !t.archived : !!t.archived === filter.archived) && (!filter.month || t.month === filter.month));
  }
  function saveTodo(input) {
    if (!plain(input) || typeof input.text !== "string" || !input.text.trim()) throw new Error("请填写待办内容");
    if (input.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error("请选择有效的具体月份");
    const idx = input.id ? user.advice_todo.findIndex(t => t.id === input.id) : -1, prev = idx >= 0 ? user.advice_todo[idx] : null;
    const todo = { ...(prev || {}), ...clone(input), id: prev ? prev.id : uid("todo"), text: input.text.trim(), month: input.month || "", note: String(input.note === undefined ? prev && prev.note || "" : input.note), done: input.done === undefined ? !!(prev && prev.done) : !!input.done, archived: input.archived === undefined ? !!(prev && prev.archived) : !!input.archived, created_at: prev && prev.created_at || now(), updated_at: now(), history: recordHistory(prev) };
    if (idx >= 0) user.advice_todo[idx] = todo; else user.advice_todo.push(todo);
    syncSelected(); save(); return todo;
  }
  function syncSelected() { user.advice_selected = [...new Set(user.advice_todo.filter(t => !t.archived && t.suggestion_id).map(t => t.suggestion_id))]; }
  function toggleTodo(id, done) {
    const prev = user.advice_todo.find(t => t.id === id); if (!prev) throw new Error("找不到这条待办");
    return saveTodo({ ...prev, done: !!done });
  }
  function archiveTodo(id, archived) {
    const prev = user.advice_todo.find(t => t.id === id); if (!prev) throw new Error("找不到这条待办");
    return saveTodo({ ...prev, archived: !!archived });
  }
  function selectSuggestion(suggestion, selected) {
    if (!plain(suggestion) || typeof suggestion.id !== "string" || typeof suggestion.text !== "string") throw new Error("建议格式不正确");
    const existing = user.advice_todo.find(t => t.suggestion_id === suggestion.id && !t.archived) || user.advice_todo.find(t => t.suggestion_id === suggestion.id) || user.advice_todo.find(t => !t.suggestion_id && t.text === suggestion.text);
    if (!selected) { if (existing && !existing.archived) return archiveTodo(existing.id, true); return null; }
    if (existing) {
      if (!existing.suggestion_id) return saveTodo({ ...existing, suggestion_id: suggestion.id, archived: false });
      return existing.archived ? archiveTodo(existing.id, false) : existing;
    }
    return saveTodo({ text: suggestion.text, month: suggestion.month || "", note: suggestion.note || "", suggestion_id: suggestion.id, done: false });
  }
  function exportObject() { return { format: "spending-journal-backup", schemaVersion: 3, exportedAt: now(), dataVersion: data.meta && data.meta.data_version || "", user: clone(user) }; }
  function mergeRecord(a, b, kind) {
    if (!a) return clone(b); if (!b) return clone(a);
    const newer = stamp(b) > stamp(a) ? b : a, older = newer === a ? b : a;
    const out = { ...clone(older), ...clone(newer) };
    if (kind === "note" && a.text !== b.text) {
      const versions = [...(a.versions || []), ...(b.versions || []), { text: older.text, at: older.updated_at || older.at || "", imported_conflict: true }];
      const seen = new Set(); out.versions = versions.filter(v => { const k = JSON.stringify(v); if (seen.has(k)) return false; seen.add(k); return true; }).slice(-100);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.history = [...(a.history || []), ...(b.history || []), (() => { const v = clone(older); delete v.history; return v; })()].slice(-100);
    return out;
  }
  function mergeUsers(local, incoming) {
    const out = { ...clone(incoming), ...clone(local), schemaVersion: 3 };
    ["junk_labels", "orphan_labels", "monthly_notes", "kind_overrides", "category_overrides", "price_overrides", "report_archives", "report_archive_events"].forEach(k => {
      out[k] = {};
      new Set([...Object.keys(local[k] || {}), ...Object.keys(incoming[k] || {})]).forEach(id => {
        const a = local[k] && local[k][id], b = incoming[k] && incoming[k][id];
        out[k][id] = typeof a === "string" || typeof b === "string" ? a || b : mergeRecord(a, b, k === "monthly_notes" ? "note" : "record");
      });
    });
    Object.entries(out.report_archive_events).forEach(([month, event]) => {
      if (stamp(event) >= stamp(out.report_archives[month])) {
        if (event.archived) out.report_archives[month] = { at: event.at || event.updated_at };
        else delete out.report_archives[month];
      }
    });
    Object.entries(out.monthly_notes).forEach(([month, note]) => {
      if (!note.archived && stamp(note) > stamp(out.report_archives[month])) delete out.report_archives[month];
    });
    out.price_override_archives = {};
    new Set([...Object.keys(local.price_override_archives || {}), ...Object.keys(incoming.price_override_archives || {})]).forEach(id => {
      const records = [...(local.price_override_archives[id] || []), ...(incoming.price_override_archives[id] || [])], seen = new Set();
      out.price_override_archives[id] = records.filter(v => { const key = JSON.stringify(v); if (seen.has(key)) return false; seen.add(key); return true; }).slice(-100);
      const clearedAt = Math.max(...out.price_override_archives[id].map(v => Date.parse(v.cleared_at) || 0), 0);
      if (out.price_overrides[id] && clearedAt > stamp(out.price_overrides[id])) delete out.price_overrides[id];
    });
    const todos = new Map(); incoming.advice_todo.forEach(t => todos.set(t.id, clone(t)));
    local.advice_todo.forEach(t => todos.set(t.id, mergeRecord(t, todos.get(t.id), "todo")));
    const suggestionTodos = new Map(), standaloneTodos = [], localTodoIds = new Set(local.advice_todo.map(t => t.id));
    [...todos.values()].forEach(t => {
      if (!t.suggestion_id) { standaloneTodos.push(t); return; }
      const previous = suggestionTodos.get(t.suggestion_id);
      if (!previous) suggestionTodos.set(t.suggestion_id, t);
      else {
        const mergedTodo = localTodoIds.has(t.id) ? mergeRecord(t, previous, "todo") : mergeRecord(previous, t, "todo");
        mergedTodo.merged_ids = [...new Set([...(previous.merged_ids || []), ...(t.merged_ids || []), previous.id, t.id])];
        suggestionTodos.set(t.suggestion_id, mergedTodo);
      }
    });
    out.advice_todo = [...standaloneTodos, ...suggestionTodos.values()];
    out.advice_selected = [...new Set(out.advice_todo.filter(t => !t.archived && t.suggestion_id).map(t => t.suggestion_id))];
    return out;
  }
  function prepareImport(input) {
    try {
      assertJSON(input);
      if (!plain(input)) throw new Error("请选择手账 JSON 备份");
      if (JSON.stringify(input).length > 10 * 1024 * 1024) throw new Error("备份超过10MB");
      if (input.format && input.format !== "spending-journal-backup") throw new Error("不是此手账的备份格式");
      if (input.schemaVersion && input.schemaVersion > 3) throw new Error("备份版本较新，暂不能导入");
      const source = has(input, "user") ? input.user : input;
      if (!["junk_labels", "monthly_notes", "advice_todo", "kind_overrides", "category_overrides", "price_overrides"].some(k => has(source || {}, k))) throw new Error("文件中没有手账用户记录");
      const incoming = migratedUser(source), merged = mergeUsers(user, incoming);
      const preview = { ok: true, errors: [], summary: { labels: Object.keys(incoming.junk_labels).length, orphanLabels: Object.keys(incoming.orphan_labels).length, notes: Object.keys(incoming.monthly_notes).length, todos: incoming.advice_todo.length, prices: Object.keys(incoming.price_overrides).length, categories: Object.keys(incoming.category_overrides).length }, merged: clone(merged), backup: exportObject() };
      prepared.set(preview, incoming); return preview;
    } catch (e) { return { ok: false, errors: [safeError(e)], summary: null }; }
  }
  function commitImport(preview) {
    if (!preview || !preview.ok || !prepared.has(preview)) return { ok: false, errors: ["请先预览并校验备份"] };
    const backup = exportObject(), incoming = prepared.get(preview);
    const merged = mergeUsers(user, incoming); validateUser(merged);
    status.lastImportBackup = backup;
    if (storage && !status.storageBlocked) {
      try { storage.setItem(KEY + "_before_import_" + uid("backup"), JSON.stringify(backup)); }
      catch (e) { return { ok: false, errors: ["导入前备份未能保存，请先导出当前记录。" + safeError(e)], backup }; }
    }
    user = merged; prepared.delete(preview);
    const saved = save(); return { ok: true, saved, backup, errors: saved ? [] : [status.message] };
  }
  const Journal = {
    data, orders, items, status, key: KEY,
    get user() { return user; },
    esc: value => String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    money: value => number(value) ? "¥" + value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "金额待核",
    stats, goodsStats, archiveOrders, candidates, labelFor, setLabel, archiveLabel, setKind, kindFor, categories, categoryFor, orderCategoryFor, setCategory, archiveCategory, priceFor, itemPriceDisplay, isClosedOrder, isStatusUnknown, setPrice, clearPrice, junkStats,
    getNote, saveNote, archiveNote, getTodos, saveTodo, toggleTodo, archiveTodo, selectSuggestion,
    exportObject, prepareImport, commitImport, save,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }
  };
  global.Journal = Journal;
})(typeof window !== "undefined" ? window : globalThis);
