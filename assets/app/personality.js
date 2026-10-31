/* Local, read-only character rules. No storage, network, or order mutations. */
(function (global) {
  "use strict";
  const ruleVersion = "personality-v1-scenes";
  const directions = [
    ["A", "兴趣与体验"], ["B", "吃喝与口味"], ["C", "穿搭与个护"],
    ["D", "趁手工具"], ["E", "服务与事务"], ["F", "居家与常备"]
  ];
  const roles = Object.freeze([
    { id: "guofurong", name: "郭芙蓉", work: "武林外传", label: "兴趣行动派", direction: "A", source_url: "https://tv.cctv.com/2014/07/27/VIDE1406399770522952.shtml", contrast: "排山倒海留在剧里，装备排面留给你。", closing: "这一页的江湖，先从购物车里的小节目开场。" },
    { id: "zhenhuan", name: "甄嬛", work: "甄嬛传", label: "衣帽间掌事人", direction: "C", source_url: "https://www.tvb.com/dramanews-c/甄嬛傳線上看劇情-後宮甄嬛傳全76集劇透懶人包-後宮大惡鬥-孫儷-陳建斌-蔡少芬-蔣欣-1002721", contrast: "借一点风格的戏份，宫里的复杂剧情就不接单了。", closing: "这页的造型指导，今天由你亲自兼任。" },
    { id: "zhubajie", name: "猪八戒", work: "西游记", label: "快乐补给官", direction: "B", source_url: "https://tv.cctv.com/2014/07/16/VIDE1405492234725766.shtml", contrast: "借的是好味道的趣味，取经路上的偷吃桥段留在剧里。", closing: "这一页的取经路，先给吃喝留一小格。" },
    { id: "sunwukong", name: "孙悟空", work: "西游记", label: "趁手工具派", direction: "D", source_url: "https://tv.cctv.com/2016/02/17/VIDELcn0ybPHKnTRt4QiqHmB160217.shtml", contrast: "借一份趁手的工具感，九九八十一难不用算进消费门槛。", closing: "金箍棒留在故事里，具体的小工具留在这一页。" },
    { id: "andy", name: "安迪", work: "欢乐颂", label: "生活项目总监", direction: "E", source_url: "https://www.iqiyi.com/a_19rrh9xr35.html", contrast: "取她整理信息的利落劲儿，精英身价不参与本次计算。", closing: "给生活一点条理，也给选择留一点空间。" },
    { id: "xuebaochai", name: "薛宝钗", work: "红楼梦", label: "日常后勤部长", direction: "F", source_url: "https://tv.cctv.com/2017/09/25/VIDE4dQA75dXSO0Q8z9rQoRS170925.shtml", contrast: "借的是妥帖的准备，大家闺秀的身份留在大观园。", closing: "小物件也有自己的戏份，普通生活值得单开一页。" }
  ].map(Object.freeze));
  const priority = ["guofurong", "sunwukong", "zhubajie", "zhenhuan", "xuebaochai", "andy"];
  const cache = new WeakMap();
  const dayMs = 86400000;
  const closed = new Set(["交易关闭", "已退款", "退款成功", "退款完成"]);
  const normal = value => String(value == null ? "" : value).normalize("NFKC").replace(/\s+/g, " ").trim();
  const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const unique = values => Array.from(new Set(values)).sort(lex);
  const numericMoney = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * dayMs).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / dayMs);
  const metric = (numerator, denominator, prior) => ({ value: prior || !denominator ? 0.5 : Math.max(0, Math.min(1, numerator / denominator)), prior: !!prior || !denominator, numerator, denominator });
  const neutral = () => metric(0, 0, true);
  const safeText = value => normal(value).replace(/<[^>]*>/g, " ").replace(/[<>\u0000-\u001f]/g, " ")
    .replace(/(^|\D)1[3-9]\d{9}(?=\D|$)/g, "$1[手机号已脱敏]")
    .replace(/1[\d*＊xX]{10}/g, "[手机号已脱敏]").replace(/[^\s，。；]*@[^\s，。；]*/g, "[邮箱已脱敏]");
  const sensitive = /医药|药品|处方|避孕|早孕|验孕|成人用品|情趣|私密|内裤|内衣|文胸|胸罩|卫生巾|卫生棉条|月经|润滑剂|壮阳|脱发药|减肥药|隐形眼镜|近视眼镜|保健品|营养粉|蛋白粉|乳清|维生素|益生菌|鱼油|钙片|叶酸|乳铁蛋白/;

  function windowFor(records, archiveDates, options) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(options.month || ""))) {
      const month = options.month, parts = month.split("-").map(Number);
      const end = new Date(Date.UTC(parts[0], parts[1], 0)).toISOString().slice(0, 10);
      return { start: month + "-01", end, label: month + " · 订单记录", mode: "month" };
    }
    const dates = records.map(row => row.date).concat(records.length ? [] : archiveDates).sort(lex);
    const end = dates[dates.length - 1] || null;
    if (!end) return { start: null, end: null, label: "当前档案", mode: "trailing12months" };
    const parts = end.split("-").map(Number), last = new Date(Date.UTC(parts[0] - 1, parts[1], 0)).getUTCDate();
    const previous = new Date(Date.UTC(parts[0] - 1, parts[1] - 1, Math.min(parts[2], last))).toISOString().slice(0, 10);
    const start = addDays(previous, 1);
    return { start, end, label: start + " 至 " + end + " · 近12个月记录", mode: "trailing12months" };
  }

  function hobby(name, spec) {
    const tests = [
      ["swimming", "游泳", /泳衣|泳裤|泳帽|泳镜|游泳|浮潜|潜水|水下耳机/, [["swimwear", /泳衣|泳裤/], ["cap", /泳帽/], ["goggles", /泳镜|游泳眼镜|潜水镜/], ["earplug", /耳塞/], ["audio", /耳机/], ["noseclip", /鼻夹/], ["fins", /脚蹼|划水掌/]]],
      ["badminton", "羽毛球", /羽毛球|羽球|球拍手胶/, [["grip", /手胶|吸汗带/], ["racket", /球拍(?!手胶|吸汗带|包|线)/], ["shoes", /鞋/], ["wear", /服|短裙|裤/], ["bag", /拍包|球包/], ["ball", /羽毛球(?!拍|鞋|服|裤|包)/]]],
      ["guitar", "吉他", /吉他|尤克里里/, [["strings", /琴弦|吉他弦/], ["pick", /拨片/], ["bag", /琴包|琴盒/], ["stand", /琴架/], ["instrument", /(?:吉他|尤克里里)(?!琴弦|弦|拨片|琴包|琴架)/]]],
      ["skiing", "滑雪", /滑雪/, [["protection", /护具|护膝|护臀/], ["goggles", /镜/], ["wear", /服|裤/], ["equipment", /雪板|雪杖/]]],
      ["craft", "手工与绘画", /钩针|刺绣|手工编织|水彩|画笔|陶艺|手工模型|模型玩具|拼图|乐高/, [["material", /毛线|线材|颜料/], ["tool", /针|笔|工具/], ["kit", /套装|拼图|乐高|模型/]]],
      ["fitness", "运动与户外", /瑜伽|健身|阻力带|哑铃|跳绳|露营|登山杖|骑行服|钓鱼竿|篮球|足球|网球拍|乒乓球/, [["equipment", /哑铃|跳绳|球拍|鱼竿|钓鱼竿/], ["wear", /服|裤|鞋/], ["mat", /垫/], ["support", /护具|护膝|阻力带/]]],
      ["music", "乐器", /钢琴|电子琴|小提琴|架子鼓|萨克斯|口琴/, [["instrument", /琴|鼓|萨克斯/], ["accessory", /琴弦|琴谱|鼓棒|簧片/]]],
      ["learning", "兴趣学习", /摄影课程|绘画课|舞蹈课|吉他课|陶艺体验|手工体验/, [["course", /课|体验/]]]
    ];
    const title = normal(name), detail = normal(spec);
    // The title's main article beats promotional bundle words and SKU extras.
    // A title with no recognizable function can still be clarified by its SKU.
    for (const text of [title, detail]) for (const [scene, label, match, functions] of tests) {
      if (!match.test(text)) continue;
      const first = value => {
        // “球拍渐变手胶” names a grip for a racket, not a racket with a gift.
        const primary = value.split(/赠送|赠品|赠|送/)[0];
        if (scene === "badminton" && /手胶|吸汗带/.test(primary)) return { key: "grip" };
        if (scene === "guitar" && /琴弦|吉他弦/.test(primary)) return { key: "strings" };
        return functions.map(([key, pattern], index) => ({ key, match: pattern.exec(primary), index }))
          .filter(found => found.match).sort((a, b) => a.match.index - b.match.index || b.match[0].length - a.match[0].length || a.index - b.index)[0];
      };
      const found = first(title) || first(detail);
      return { direction: "A", purpose: scene, purpose_label: label, function_key: found ? found.key : "unresolved" };
    }
    return null;
  }

  function classify(row) {
    const text = row.name + " " + row.spec, category = row.category;
    const result = (direction, purpose, label, fn) => ({ direction, purpose, purpose_label: label, function_key: fn || purpose });
    const byCategory = {
      "食品饮料": ["B", "food", "吃喝与口味"], "服饰穿搭": ["C", "style_care", "穿搭与个护"], "鞋包配饰": ["C", "style_care", "穿搭与个护"], "美妆个护": ["C", "style_care", "穿搭与个护"],
      "3C数码": ["D", "tools", "趁手工具"], "家用电器": ["D", "tools", "趁手工具"], "虚拟服务": ["E", "services", "服务与事务"], "旅游出行": ["E", "travel", "出行事务"], "文娱票务": ["E", "tickets", "票务安排"], "家居日用": ["F", "household", "居家与常备"]
    };
    if (row.category_overridden) {
      if (byCategory[category]) return result(...byCategory[category]);
      if (["运动户外", "文娱爱好", "图书文具"].includes(category)) return hobby(row.name, row.spec) || result("A", "personal_interest", "本人确认的兴趣场景");
      return null;
    }
    const scene = hobby(row.name, row.spec);
    if (scene) return scene;
    if (/话费|手机充值|流量卡|SIM卡|上网卡|会员.{0,8}(?:月卡|季卡|年卡)|(?:月|季|年)卡会员|视频会员|微信读书.*(?:会员|年卡)|补签卡|机票|航班|酒店|客栈.*(?:房|入住)|高铁票|火车票|电影票|演出票|宠物托运|护理.{0,6}次卡/i.test(text)) return result("E", "services", "服务与事务");
    if (/洗衣机.{0,12}(?:清洁|清洗|消毒|除垢)|床单|床笠|被套|四件套|被罩|收纳|分装袋|餐具|泡面碗|咖啡杯|纸杯|玻璃杯|水杯|拖把|纸巾|洗衣液|清洁剂|垃圾袋|保鲜袋|浴巾|毛巾/.test(text)) return result("F", "household", "居家与常备");
    if (/手机壳|保护膜|充电|数据线|耳机|电脑|手机|平板|电器|相机|洗衣机|冰箱|吸尘器|剃须刀|脱毛仪|美容仪|电动牙刷|螺丝刀|钻头|工具箱|apple\s*pencil|airpods|iphone|ipad|macbook/i.test(text)) {
      const accessory = /手机壳|保护膜|充电器|充电线|数据线|替换|适配器|滤芯|刷头|电池/.test(text);
      return result("D", "tools", "趁手工具", accessory ? "accessory" : "body");
    }
    if (/袜|鞋|靴|连衣裙|短裙|半身裙|上衣|T恤|体恤|衬衫|外套|卫衣|棉衣|羽绒|牛仔裤|长裤|短裤|胸衣|Tee\b|耳环|项链|手链|发绳|发夹|帽子|洗发水|护发素|面霜|胶原霜|手霜|口红|唇膏|芦荟胶|香水|洁面/i.test(text)) return result("C", "style_care", "穿搭与个护");
    if (byCategory[category]) return result(...byCategory[category]);
    if (/牛奶|咖啡|茶叶|饮料|零食|饼干|巧克力|汉堡|披萨|白酒|啤酒|矿泉水|面包|奶酪|麦片|水果/.test(text)) return result("B", "food", "吃喝与口味");
    if (category === "宠物用品" && /猫粮|狗粮|主食罐|猫条|宠物.*(?:清洁|收纳)|猫砂/.test(text)) return result("F", "pet_supplies", "宠物常备用品");
    return null;
  }

  function collect(J) {
    const orders = Array.isArray(J.orders) ? J.orders.filter(order => order && typeof order === "object") : [];
    const flat = (Array.isArray(J.items) ? J.items : orders.flatMap(order => (Array.isArray(order.items) ? order.items : []).filter(item => item && typeof item === "object").map(item => ({ ...item, order })))).filter(item => item && typeof item === "object");
    const rows = [], excluded = {}, seen = new Set(), archiveDates = unique(orders.map(order => order.date).filter(validDate));
    for (const item of flat.slice().sort((a, b) => lex(String(a.id || a.item_id || ""), String(b.id || b.item_id || "")))) {
      const order = item.order || orders.find(candidate => (candidate.items || []).some(source => source === item || (source.item_id && source.item_id === item.item_id))) || {};
      const id = String(item.id || item.item_id || ""), orderId = String(order.order_id || "");
      let reason = "";
      if (!id || !orderId) reason = "missing_identity";
      else if (seen.has(id)) continue;
      seen.add(id);
      let category = item.category || "待确认";
      if (typeof J.categoryFor === "function" && id) { try { category = J.categoryFor(id) || category; } catch (_) { /* Leave the supplied category intact. */ } }
      const name = normal(item.name), spec = normal(item.spec);
      if (!reason && !validDate(order.date)) reason = "invalid_date";
      if (!reason && closed.has(normal(order.status))) reason = "closed";
      if (!reason && (typeof J.isStatusUnknown === "function" ? J.isStatusUnknown(order) : order.is_status_unknown === true || !normal(order.status) || ["未知", "状态未知", "待核", "状态待核", "unknown"].includes(normal(order.status).toLowerCase()))) reason = "status_unknown";
      if (!reason && (order.is_recharge || category === "充值储值")) reason = "stored_value";
      if (!reason && (item.is_gift || item.is_activity || item.is_metadata || item.is_adjustment || item.category_vote === false || /^(?:阶段[一二三123]|已完成$|服务内容[:：]|【?(?:赠品|限时礼赠)[】\s:：])/.test(name))) reason = "supplementary_row";
      if (!reason && (category === "医药健康" || item.category === "医药健康" || sensitive.test(name + " " + spec + " " + category))) reason = "private_or_health";
      if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue; }
      const row = { id, order_id: orderId, date: order.date, name, spec, category, category_overridden: !!(J.user && J.user.category_overrides && J.user.category_overrides[id] && !J.user.category_overrides[id].archived), qty: item.qty, product_id: normal(item.product_id), sku_id: normal(item.sku_id), unit_paid: item.unit_paid, unit_paid_verified: item.unit_paid_verified === true, precision_note: normal(item.unit_paid_precision_note) };
      Object.assign(row, classify(row) || { direction: null, purpose: null, function_key: null });
      rows.push(row);
    }
    rows.sort((a, b) => lex(a.date, b.date) || lex(a.order_id, b.order_id) || lex(a.id, b.id));
    return { rows, excluded, archiveDates, orderCount: new Set(orders.map(order => String(order.order_id || "")).filter(Boolean)).size };
  }

  function eventsFor(rows) {
    const map = new Map();
    for (const row of rows.filter(item => item.direction)) {
      const key = row.date + "|" + row.direction + "|" + row.purpose;
      if (!map.has(key)) map.set(key, { date: row.date, direction: row.direction, purpose: row.purpose, purpose_label: row.purpose_label, rows: [] });
      map.get(key).rows.push(row);
    }
    return Array.from(map.values()).sort((a, b) => lex(a.date, b.date) || lex(a.direction, b.direction) || lex(a.purpose, b.purpose));
  }

  function repetition(rows) {
    const groups = new Map();
    for (const row of rows) {
      const spec = normal(row.spec);
      let key = null;
      if (row.product_id && row.sku_id) key = "pid:" + row.product_id + "|sku:" + row.sku_id;
      else if (row.product_id && spec && spec !== "暂无") key = "pid:" + row.product_id + "|spec:" + spec;
      else if (row.name && spec && spec !== "暂无") key = "full:" + row.name + "|" + spec;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(row.date);
    }
    const allDates = new Set(Array.from(groups.values()).flatMap(set => Array.from(set)));
    const counts = Array.from(groups.values()).map(set => set.size);
    return metric(counts.reduce((n, count) => n + Math.max(count - 1, 0), 0), counts.reduce((n, count) => n + count, 0), allDates.size < 2);
  }

  function choiceKey(row) {
    if (row.product_id && row.sku_id) return "pid:" + row.product_id + "|sku:" + row.sku_id;
    if (row.product_id && row.spec && row.spec !== "暂无") return "pid:" + row.product_id + "|spec:" + row.spec;
    if (row.name && row.spec && row.spec !== "暂无") return "full:" + row.name + "|" + row.spec;
    return null;
  }
  function uniqueFunctionRows(rows) {
    const seen = new Set();
    return rows.slice().sort((a, b) => lex(a.date, b.date) || lex(a.id, b.id)).filter(row => {
      const key = choiceKey(row) || "row:" + row.id;
      if (seen.has(key)) return false;
      seen.add(key); return row.function_key && row.function_key !== "unresolved";
    });
  }

  function kitMetric(rows) {
    const scenes = new Map(), clusters = [];
    for (const row of rows.filter(item => item.direction === "A" && item.function_key !== "unresolved")) {
      if (!scenes.has(row.purpose)) scenes.set(row.purpose, []);
      scenes.get(row.purpose).push(row);
    }
    for (const [scene, entries] of scenes) {
      let current = null;
      for (const row of entries) {
        if (!current || daysBetween(current.start, row.date) > 6) {
          current = { scene, start: row.date, end: row.date, functions: new Set(), rows: [] }; clusters.push(current);
        }
        current.end = row.date; current.rows.push(row);
      }
    }
    clusters.forEach(group => { group.functions = new Set(uniqueFunctionRows(group.rows).map(row => row.function_key)); });
    return { ...metric(clusters.filter(group => group.functions.size >= 3).length, clusters.length), clusters: clusters.map(group => ({ scene: group.scene, start: group.start, end: group.end, functions: Array.from(group.functions).sort(lex), item_ids: unique(group.rows.map(row => row.id)) })) };
  }

  function novelty(allRows, end) {
    if (!end) return neutral();
    const recentStart = addDays(end, -29), historyStart = addDays(recentStart, -180);
    const history = allRows.filter(row => row.date >= historyStart && row.date < recentStart);
    const recent = allRows.filter(row => row.date >= recentStart && row.date <= end && row.direction === "A");
    const recentScenes = new Set(recent.map(row => row.purpose)), oldScenes = new Set(history.filter(row => row.direction === "A").map(row => row.purpose));
    const historicalMonths = new Set(history.map(row => row.date.slice(0, 7)));
    const span = history.length ? daysBetween(history[0].date, recentStart) : 0;
    return { ...metric(Array.from(recentScenes).filter(scene => !oldScenes.has(scene)).length, recentScenes.size, span < 90 || historicalMonths.size < 3), history_span_days: span, history_months: historicalMonths.size };
  }

  function modelTokens(row) {
    const pattern = /(?:iphone\s*\d{1,2}(?:\s*(?:pro\s*max|pro|plus|mini))?|ipad\s*(?:pro|air|mini)?\s*\d{1,2}|airpods\s*(?:pro)?\s*\d?|macbook\s*(?:pro|air)\s*\d{1,2}|[a-z]{2,8}[- ]\d{2,5}[a-z]{0,3})/g;
    const tokens = value => unique((normal(value).toLowerCase().match(pattern) || []).map(token => token.replace(/\s+/g, "")));
    const spec = tokens(row.spec);
    if (spec.length) return spec.length === 1 ? spec : [];
    if (/\d\s*[\/、-]\s*\d/.test(row.name)) return [];
    const title = tokens(row.name);
    return title.length === 1 ? title : [];
  }
  function upkeep(rows, events) {
    const toolRows = rows.filter(row => row.direction === "D").map(row => ({ ...row, models: modelTokens(row) }));
    const analyzable = events.filter(event => event.direction === "D" && event.rows.some(row => modelTokens(row).length));
    const associated = analyzable.filter(event => event.rows.some(row => {
      const models = modelTokens(row);
      return models.length && toolRows.some(other => other.id !== row.id && models.some(model => other.models.includes(model)) && row.function_key !== other.function_key && [row.function_key, other.function_key].includes("accessory"));
    }));
    return metric(associated.length, analyzable.length);
  }

  function signaturePatterns(rows, window) {
    const start = window.mode === "month" ? window.start : window.end && addDays(window.end, -89);
    const recent = rows.filter(row => start && row.date >= start && row.date <= window.end), patterns = [];
    const make = (type, role_id, tier, entries, scale, detail) => {
      const sorted = entries.slice().sort((a, b) => lex(a.date, b.date) || lex(a.id, b.id));
      return { type, role_id, tier, scale, start: sorted[0].date, end: sorted[sorted.length - 1].date,
        item_ids: unique(sorted.map(row => row.id)), order_ids: unique(sorted.map(row => row.order_id)), ...detail };
    };
    for (const cluster of kitMetric(recent).clusters.filter(group => group.functions.length >= 3)) {
      const ids = new Set(cluster.item_ids), entries = recent.filter(row => ids.has(row.id));
      patterns.push(make("complete_kit", "guofurong", 3, entries, cluster.functions.length,
        { purpose: cluster.scene, purpose_label: entries[0].purpose_label, direction: "A", functions: cluster.functions }));
    }
    const models = new Map();
    for (const row of recent.filter(row => row.direction === "D")) for (const model of modelTokens(row)) {
      if (!models.has(model)) models.set(model, []); models.get(model).push(row);
    }
    for (const [model, entries] of models) {
      const distinct = uniqueFunctionRows(entries);
      if (!distinct.some(row => row.function_key === "body") || !distinct.some(row => row.function_key === "accessory")) continue;
      patterns.push(make("model_pair", "sunwukong", 2, entries, distinct.length,
        { model, purpose: "tools", purpose_label: "型号适配", direction: "D" }));
    }
    const repetitions = new Map();
    for (const row of recent.filter(row => ["B", "C", "F"].includes(row.direction))) {
      const key = choiceKey(row); if (!key) continue;
      const group = row.direction + "|" + key;
      if (!repetitions.has(group)) repetitions.set(group, []); repetitions.get(group).push(row);
    }
    const recurrentRole = { B: "zhubajie", C: "zhenhuan", F: "xuebaochai" };
    for (const entries of repetitions.values()) {
      const dates = unique(entries.map(row => row.date)); if (dates.length < 3) continue;
      const first = entries[0];
      patterns.push(make("exact_recurrence", recurrentRole[first.direction], 1, entries, dates.length,
        { dates, direction: first.direction, purpose: first.purpose, purpose_label: first.purpose_label }));
    }
    patterns.sort((a, b) => b.tier - a.tier || b.scale - a.scale || lex(b.end, a.end) ||
      priority.indexOf(a.role_id) - priority.indexOf(b.role_id) || lex(a.item_ids.join("|"), b.item_ids.join("|")));
    return { start, end: window.end, mode: window.mode === "month" ? "month" : "recent90days", patterns };
  }

  function labelFor(J, id) {
    try { return typeof J.labelFor === "function" ? J.labelFor(id) : (J.user && J.user.junk_labels || {})[id]; } catch (_) { return null; }
  }
  function usage(J, rows) {
    const labels = rows.filter(row => row.direction === "E").map(row => labelFor(J, row.id)).filter(label => label && ["low", "ok"].includes(label.status));
    return metric(labels.filter(label => label.status === "ok").length, labels.length);
  }

  function subject(row) {
    const sceneNames = {swimming:{swimwear:"泳衣",cap:"泳帽",goggles:"泳镜",earplug:"耳塞",audio:"水下耳机",noseclip:"鼻夹",fins:"脚蹼"},badminton:{grip:"羽毛球拍手胶",racket:"羽毛球拍",ball:"羽毛球",wear:"运动服",shoes:"球鞋",bag:"球拍包"},guitar:{strings:"吉他琴弦",pick:"拨片",bag:"琴包",stand:"琴架",instrument:"吉他"}};
    if(sceneNames[row.purpose] && sceneNames[row.purpose][row.function_key]) return sceneNames[row.purpose][row.function_key];
    const patterns = {B:[[/红豆薏米水/,"红豆薏米水"],[/芬达/,"芬达"],[/可口可乐|零度可乐/,"可乐"],[/饼干/,"饼干"],[/巧克力/,"巧克力"],[/咖啡/,"咖啡"]],C:[[/睡衣|家居服/,"家居服"],[/大衣|风衣/,"大衣"],[/连衣裙/,"连衣裙"],[/半身裙/,"半身裙"],[/羽绒/,"羽绒服"],[/衬衫/,"衬衫"],[/外套/,"外套"],[/毛衣|针织衫/,"针织衫"],[/裤/,"裤装"],[/鞋|靴/,"鞋子"],[/防晒/,"防晒小物"],[/精华/,"精华"],[/面霜|乳霜|手霜/,"护理小物"]],D:[[/脱毛仪/,"脱毛仪"],[/充电|数据线/,"充电线材"],[/手机.*膜|钢化膜|防窥膜/,"手机膜"],[/耳机/,"耳机"],[/ipad/i,"iPad"],[/电脑|笔记本/,"电脑"]],F:[[/洗衣机.*(?:清洁|清洗|消毒)/,"洗衣机清洁液"],[/洗衣液/,"洗衣液"],[/纸巾/,"纸巾"],[/收纳/,"收纳用品"],[/餐具|碗|杯/,"餐厨小物"]],E:[[/宠物托运/,"宠物托运服务"],[/会员/,"会员服务"],[/话费/,"话费服务"],[/票/,"票务安排"]]};
    for(const [pattern,label] of patterns[row.direction]||[]) if(pattern.test(row.name)) return label;
    const cleaned=safeText(row.name).replace(/【[^】]*】|\[[^\]]*\]/g,"").trim();
    return cleaned.length>28?cleaned.slice(0,27)+"…":cleaned;
  }
  function factFor(event, index) {
    const rows = event.rows.slice().sort((a, b) => lex(a.id, b.id));
    const names = unique(rows.map(subject)).filter(Boolean), compact = name => name.length > 10 ? name.slice(0, 9) + "…" : name;
    const visibleNames = names.slice(0, event.purpose === "swimming" ? 5 : 2).map(compact);
    while (visibleNames.length > 1 && visibleNames.join("、").length + (visibleNames.length < names.length ? 1 : 0) > 20) visibleNames.pop();
    const listed = visibleNames.join("、") + (visibleNames.length < names.length ? "等" : "");
    const date = event.start && event.start !== event.date ? event.start + "至" + event.date.slice(5) : event.date;
    const tails = { A: "给兴趣留个节目，购物车先报上名。", B: "日常补给也有自己的快乐节目。", C: "给喜欢的样子留个位置，日常也值得打扮。", D: "日常道具组添员，趁手比排场更有戏。", E: "清单接住一件小事，生活办公室开张。", F: "小东西不抢戏，生活后勤部照常营业。" };
    let text = date + "，" + (listed || event.purpose_label) + "入列。" + tails[event.direction];
    if (event.purpose === "swimming") text = date + "，" + listed + "集中登场，购物车组起一支游泳队。";
    if (event.purpose === "guitar") text = date + "，" + listed + "安排上了，兴趣清单连背景音乐也有了。";
    if (event.pattern_type === "model_pair") text = date + "，" + listed + "按同一型号在清单里会合，道具组讲究对得上。";
    if (event.pattern_type === "exact_recurrence") text = date + "，" + compact(names[0] || event.purpose_label) + "在" + event.dates.length + "个日期出现，这个选择有自己的返场位。";
    const titles = { A: "兴趣来了先组队", B: "日常补给也有戏", C: "喜欢的样子有位置", D: "道具组要趁手", E: "生活小事有人接单", F: "日常后勤没掉队" };
    const result = { title: titles[event.direction], text, order_ids: unique(rows.map(row => row.order_id)), item_ids: unique(rows.map(row => row.id)), date: event.date, fact_type: event.pattern_type || "purchase_event" };
    if (event.start && event.start !== event.date) result.date_range = { start: event.start, end: event.date };
    if (rows.length === 1 && rows[0].unit_paid_verified && numericMoney(rows[0].unit_paid) && Number.isInteger(rows[0].qty) && rows[0].qty > 0 && !rows[0].precision_note) {
      result.amount_cents = Math.round(rows[0].unit_paid * 100); result.amount_basis = "unit_paid";
    }
    return result;
  }

  function analyze(J, options) {
    J = J && typeof J === "object" ? J : {}; options = options && typeof options === "object" ? options : {};
    const source = collect(J), window = windowFor(source.rows, source.archiveDates, options);
    const rows = source.rows.filter(row => window.start && row.date >= window.start && row.date <= window.end);
    const labelSnapshot = rows.map(row => { const label = labelFor(J, row.id); return [row.id, label && label.status, !!(label && label.archived)]; });
    const fingerprint = JSON.stringify([ruleVersion, options.month || null, J.data && J.data.meta && J.data.meta.data_version, source.rows, source.excluded, source.archiveDates, source.orderCount, labelSnapshot]);
    const previous = cache.get(J);
    if (previous && previous.fingerprint === fingerprint) return copy(previous.result);
    const events = eventsFor(rows), counts = Object.fromEntries(directions.map(([key]) => [key, events.filter(event => event.direction === key).length]));
    const shares = Object.fromEntries(directions.map(([key]) => [key, events.length ? counts[key] / events.length : 0]));
    const signatures = signaturePatterns(rows, window), recentRows = rows.filter(row => signatures.start && row.date >= signatures.start), recentEvents = eventsFor(recentRows);
    const behaviors = { K: kitMetric(recentRows), N: novelty(source.rows, window.end), U: upkeep(recentRows, recentEvents), R: {}, Q_use: usage(J, recentRows), Q_note: neutral() };
    ["B", "C", "F"].forEach(key => { behaviors.R[key] = repetition(recentRows.filter(row => row.direction === key)); });
    const pairs = { guofurong: [behaviors.K, behaviors.N, "K", "N"], zhenhuan: [behaviors.R.C, behaviors.Q_note, "R_C", "Q_note"], zhubajie: [behaviors.R.B, behaviors.Q_note, "R_B", "Q_note"], sunwukong: [behaviors.U, behaviors.Q_note, "U", "Q_note"], andy: [behaviors.Q_note, behaviors.Q_use, "Q_note", "Q_use"], xuebaochai: [behaviors.R.F, behaviors.Q_note, "R_F", "Q_note"] };
    const scores = roles.map(role => {
      const [b1, b2, n1, n2] = pairs[role.id], positive = events.filter(event => event.direction === role.direction).map(event => event.date).sort(lex);
      return { role_id: role.id, P: shares[role.direction], B1: b1.value, B2: b2.value, score: 70 * shares[role.direction] + 15 * b1.value + 15 * b2.value, behavior_names: [n1, n2], observed: [!b1.prior, !b2.prior], independent_hits: [b1, b2].filter(value => !value.prior && value.value > 0).length, latest_date: positive[positive.length - 1] || "" };
    }).sort((a, b) => b.score - a.score || b.P - a.P || b.independent_hits - a.independent_hits || lex(b.latest_date, a.latest_date) || priority.indexOf(a.role_id) - priority.indexOf(b.role_id));
    const primary = signatures.patterns[0] || null;
    const opening = !events.length, selected = roles.find(role => role.id === (opening ? "andy" : primary ? primary.role_id : scores[0].role_id));
    const chosenEvents = events.filter(event => event.direction === selected.direction).sort((a, b) => (selected.direction === "A" ? new Set(b.rows.map(row => row.function_key)).size - new Set(a.rows.map(row => row.function_key)).size : 0) || lex(b.date, a.date) || lex(a.purpose, b.purpose));
    const distinctEvents = [], seenFacts = new Set(), usedDirections = new Set();
    const append = event => {
      const signature = unique(event.rows.map(subject)).join("|");
      if (seenFacts.has(signature) || distinctEvents.length === 3) return false;
      seenFacts.add(signature); usedDirections.add(event.direction); distinctEvents.push(event); return true;
    };
    if (primary) {
      const ids = new Set(primary.item_ids);
      append({ rows: rows.filter(row => ids.has(row.id)), date: primary.end, start: primary.start,
        direction: primary.direction, purpose: primary.purpose, purpose_label: primary.purpose_label,
        pattern_type: primary.type, dates: primary.dates });
    } else if (chosenEvents.length) append(chosenEvents[0]);
    const otherEvents = events.filter(event => !primary || event.date >= signatures.start)
      .sort((a, b) => lex(b.date, a.date) || lex(a.direction, b.direction) || lex(a.purpose, b.purpose));
    for (const event of otherEvents) if (!usedDirections.has(event.direction)) append(event);
    if (distinctEvents.length < 3) for (const event of otherEvents) append(event);
    const facts = opening ? [] : distinctEvents.map(factFor);
    const lead = { A: "给兴趣一点装备，给日子一点节目，这页购物车自带江湖气。", B: "取经是大事，吃好也不是小事。", C: "衣帽间认真营业，宫斗业务概不接单。", D: "困难可以有，冤枉力气少出点。", E: "待办可以慢慢做，总裁气质先到位。", F: "日常小麻烦，交给后勤小分队。" };
    const taglines = { A: "兴趣刚上头，装备已满级。", B: "大师兄负责降妖，我负责加餐。", C: "本宫不争宠，今天只争穿搭C位。", D: "能交给工具的，绝不徒手渡劫。", E: "生活这家公司，先给自己封个总。", F: "生活没有管家，小物件先领编制。" };
    let summary = lead[selected.direction];
    if (primary && primary.type === "complete_kit") summary = usedDirections.size > 1 ? "兴趣一来先组队，日常补给也不落下。" : "兴趣一出场，装备就组队，购物车里的小江湖热闹起来了。";
    const scopeLabel = window.mode === "month" ? "本月" : "近90天";
    const matchReason = primary ? primary.type === "complete_kit" ? scopeLabel + "里，" + primary.functions.length + "种" + primary.purpose_label + "装备集中配齐，先按这幕具体行为选角。" : primary.type === "model_pair" ? scopeLabel + "有同一明确型号的主体与适配件，趁手的搭配比品类数量更有辨识度。" : scopeLabel + "里，同款同规格在" + primary.dates.length + "个日期返场，这个选择成了本期主线。" : opening ? "这一页先给生活一个清爽开场。" : "这一页先从" + (directions.find(([key]) => key === selected.direction) || ["", "生活小事"])[1] + "的选择开场。";
    const result = {
      role_id: selected.id, role_name: selected.name, work_title: selected.work, role_label: selected.label,
      tagline: primary && primary.type === "complete_kit" && primary.purpose === "swimming" ? "泳技先不打分，装备直接保送。" : taglines[selected.direction],
      summary,
      match_reason: matchReason,
      facts, contrast: selected.contrast, closing: selected.closing, window, rule_version: ruleVersion,
      directions: directions.map(([key, label]) => ({ key, label, share: shares[key], event_count: counts[key] })),
      debug: { scores, behaviors, signatures: signatures.patterns, selection_window: { start: signatures.start, end: signatures.end, mode: signatures.mode }, default_opening: opening, selected_by: opening ? "default_opening" : primary ? "specific_behavior_then_stable_ties" : "background_score_then_stable_ties", event_count: events.length, eligible_item_count: rows.length, unassigned_item_count: rows.filter(row => !row.direction).length, archive_order_count: source.orderCount, excluded: source.excluded, events: events.map(event => ({ date: event.date, direction: event.direction, purpose: event.purpose, order_ids: unique(event.rows.map(row => row.order_id)), item_ids: unique(event.rows.map(row => row.id)), function_count: new Set(uniqueFunctionRows(event.rows).map(row => row.function_key)).size })), feedback_policy: "Q_note remains neutral; price notes and unrelated remarks are not interpreted." }
    };
    cache.set(J, { fingerprint, result: copy(result) });
    return copy(result);
  }
  global.JournalPersonality = Object.freeze({ analyze, roles, ruleVersion });
})(typeof window !== "undefined" ? window : globalThis);
