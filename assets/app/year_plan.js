/* Read-only default plan; only explicit edits/checks materialize core todos. */
(function (global) {
  "use strict";
  const year = String(global.JOURNAL_PROJECT && global.JOURNAL_PROJECT.advice_year || new Date().getFullYear() + 1);
  const monthKey = n => year + "-" + String(n).padStart(2, "0");
  const stamp = task => Date.parse(task.updated_at || task.at || task.created_at || "") || 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  function defaults(J) {
    const rows = (J.items || []).filter(it => !it.is_gift && !it.is_adjustment && !it.is_metadata && !it.is_activity &&
      !(it.order && (it.order.is_recharge || (J.isClosedOrder && J.isClosedOrder(it.order)) || (J.isStatusUnknown && J.isStatusUnknown(it.order)))) && it.category !== "医药健康");
    const low = rows.some(it => { const label = J.labelFor && J.labelFor(it.item_id || it.id); return label && label.status === "low"; });
    const has = pattern => rows.some(it => pattern.test(String(it.name || "")));
    const swimming = has(/游泳|泳衣|泳镜|泳帽/), guitar = has(/吉他|琴弦|拨片/);
    const entries = [
      [1, "review___YEAR___01", "留十分钟翻翻最近的订单，挑出3件最常用的物品，给它们颁个小奖。"],
      [1, "use_review___YEAR___01", low ? "回看1件自己标过低频的物品，写一句现在想怎么用它。" : "挑1件手边常用的东西，写一句它帮了你什么。"],
      [2, "money_check___YEAR___02", "选1笔最近的消费，核对商品实付和数量，给账本做一次小对账。"],
      [2, "year_plan___YEAR___02_drawer", "整理一个小抽屉，找出仍在手边、下次能直接拿来用的物品。"],
      [3, "monthly_review___YEAR___03", "回看本月新增订单和使用反馈，留下一个喜欢的选择，以及一件想调整的小事。"],
      [3, "year_plan___YEAR___03_interest", "翻一翻买过的兴趣用品，只选一件还在手边的，给自己留一次尝试的时间。"],
      [4, "year_plan___YEAR___04_clothes", "看看现有衣物，挑一套愿意再穿的搭配；先从手边的选择开始。"],
      [4, "year_plan___YEAR___04_care", "检查一件常用工具是否需要清洁或简单维护，做完一小步就好。"],
      [5, "year_plan___YEAR___05_interest", swimming ? "回看买过的泳具，看看哪些还在手边；如果愿意，给自己留一次尝试游泳的时间。" : "选一件还在手边的兴趣用品，看看配件是否齐全；愿意时再安排一次尝试。"],
      [5, "year_plan___YEAR___05_feedback", "给一件已有物品补一句使用反馈，正常使用和低频都可以如实记。"],
      [6, "year_plan___YEAR___06_supplies", "看看一小处日用品存放位置，记下手边已有的东西，方便下次寻找。"],
      [6, "year_plan___YEAR___06_labels", "回看一条旧使用标签；想法变了就修改，想暂时收起来就归档。"],
      [7, "year_plan___YEAR___07_interest", guitar ? "回看买过的吉他用品，找找还在手边的琴弦或拨片；愿意时安排一次小练习。" : "翻一翻记录里的兴趣小物，选一件还在手边的，安排一次轻松的小练习。"],
      [7, "year_plan___YEAR___07_repair", "找出一件因小问题搁置的物品，看看能否清洁、整理或简单修复；不必勉强。"],
      [8, "year_plan___YEAR___08_digital", "整理一小部分文件或设备配件，让下次需要的东西更容易找到。"],
      [8, "year_plan___YEAR___08_review", "回看一件标为低频或正常使用的物品，补一句现在的感受；没有标签就任选一件。"],
      [9, "year_plan___YEAR___09_read", "从手边的书、笔记或学习资料里挑一份，只给自己留十分钟翻看。"],
      [9, "year_plan___YEAR___09_small", "挑一条还没完成的小任务，拆成十分钟能做完的一步，今天就做这一步。"],
      [10, "year_plan___YEAR___10_interest", "给一个喜欢的兴趣留一点时间，先看看现有物品能支持怎样的小尝试。"],
      [10, "year_plan___YEAR___10_note", "给本月一次让你开心的选择写一句夸夸，留下它值得的地方。"],
      [11, "year_plan___YEAR___11_wishlist", "给下一次购买写一张三行清单：想解决什么、已有同类物、真正需要的功能。"],
      [11, "year_plan___YEAR___11_existing", "遇到同类购买想法时，先看看买过的记录和手边现有物品，再按自己的需要决定。"],
      [12, "year_plan___YEAR___12_review", "挑三件今年记录过的物品，回看自己的使用反馈；只写真实想到的部分。"],
      [12, "year_plan___YEAR___12_next", "从今年的小任务里，留下一个愿意继续的习惯；其余的可以安心归档。"]
    ];
    return entries.map(([month, rawKey, text]) => { const key = rawKey.replace("__YEAR__", year); return ({ key, suggestion_id: key, month: monthKey(month), text,
      note: "可以按自己的需要改写、移月或归档。", done: false, archived: false, is_auto: true }); });
  }
  function build(J) {
    const stored = J.user && Array.isArray(J.user.advice_todo) ? J.user.advice_todo : [];
    const bases = defaults(J), keys = new Set(bases.map(task => task.suggestion_id));
    const tasks = bases.map(base => {
      const matches = stored.filter(task => task.suggestion_id === base.suggestion_id).slice().sort((a, b) =>
        stamp(b) - stamp(a) || String(a.id || "").localeCompare(String(b.id || "")));
      const saved = matches[0];
      return saved ? { ...base, ...copy(saved), key: base.key, suggestion_id: base.suggestion_id, is_auto: false } : base;
    });
    const extras = stored.filter(task => !keys.has(task.suggestion_id)).map(task => ({ ...copy(task),
      key: "todo:" + task.id, suggestion_id: task.suggestion_id || null, note: task.note || "", done: !!task.done, archived: !!task.archived, is_auto: false }));
    return { year, months: Array.from({ length: 12 }, (_, i) => {
      const month = monthKey(i + 1), rows = tasks.filter(task => task.month === month);
      return { month, label: (i + 1) + "月", tasks: rows.filter(task => !task.archived), archivedTasks: rows.filter(task => task.archived) };
    }), tasks, extras };
  }
  function task(J, key) {
    if (typeof key !== "string" || !key) return null;
    const plan = build(J);
    return [...plan.tasks, ...plan.extras].find(row => row.key === key || row.id === key || row.suggestion_id === key) || null;
  }
  function requireTask(J, key) {
    const row = task(J, key);
    if (!row) throw new Error("找不到这条年度小任务");
    return row;
  }
  function materialize(J, key) {
    const row = requireTask(J, key);
    if (row.id) return row;
    J.saveTodo({ text: row.text, month: row.month, note: row.note, suggestion_id: row.suggestion_id, done: row.done, archived: row.archived });
    return task(J, row.key);
  }
  function toggle(J, key, done) {
    const row = requireTask(J, key);
    if (row.id) J.toggleTodo(row.id, !!done);
    else J.saveTodo({ text: row.text, month: row.month, note: row.note, suggestion_id: row.suggestion_id, done: !!done, archived: row.archived });
    return task(J, row.key);
  }
  global.JournalYearPlan = Object.freeze({ build, task, materialize, toggle });
})(typeof window !== "undefined" ? window : globalThis);
