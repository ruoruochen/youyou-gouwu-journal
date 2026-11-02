---
name: youyou-gouwu-journal
description: "Analyze X years of personal Taobao purchases (淘宝消费记录): automatically collect and resume orders, verify item-level paid prices, preserve labels, and create a six-module journal with happiness reports and shareable fictional-character matches. Use for buyer spending reviews and incremental updates, not seller operations or purchasing."
---

# Youyou Gouwu Journal · Trial

Turn “analyze X years of my Taobao purchases” into a working personal journal. The assistant handles setup, paths, pagination, imports, backups, and articles. In the normal flow, the user only signs into Taobao and labels item usage. Do not delegate shell commands, spreadsheet preparation, or page-by-page work to the user.

## Start an isolated project

1. Read the requested year count; default to 10 if omitted. Use the user's authorized writable workspace, otherwise the current chat workspace. Keep all private projects outside the skill directory.
2. Run `python3 -B <skill>/scripts/start.py --years N --workspace <workspace>`. Its JSON returns the workbench URL, project path, and date range. An active project with the same range can resume. Use `--project <project>` to explicitly continue an earlier project; use `--new` when switching accounts or creating a separate analysis. Never overwrite an existing journal, copy the author's records, or modify an existing deployed site.
3. Open the returned loopback URL for the user. Do not ask them to install Python packages, run commands, or import files manually. Check browser dependencies through the environment's supported tools; handle setup the assistant can complete. If a required capability cannot be supplied, explain the specific dependency and do not claim collection succeeded.

## Collect and resume automatically

Read [collection and checkpoints](references/collection.md), then the environment's browser skill and current runtime guide. Browser-tool constraints take precedence over these examples. Use one task space owned by this project and reuse its list/detail pages.

1. Open Taobao's purchased-orders page. The user handles sign-in and security challenges in the browser; never request passwords, challenge text, or exported credentials. Once signed-in orders are visible, continue without asking again.
2. Use an official export only when a supported export control is actually visible. Do not assume every account has full export. Otherwise collect the list directly; do not ask the user to locate an export or provide Excel files.
3. Pass the managed task to `run(task, options)` from `scripts/collect.mjs`. Scripts read visible pages in serial, newest to oldest, and save checkpoints. Do not search orders/products, access private APIs, replay captured requests, extract cookies/tokens, or use multiple accounts/proxies to avoid limits.
4. Ingest batches automatically through `scripts/ingest_exports.py` / `journal.py ingest`. Cache actual observed product images. Ordinary missing fields enter a review queue; do not interrupt the user for each item.
5. Continue bounded batches from the same checkpoint without sending every page back to the model. Default serial navigation is approximately 4.5 seconds, with an 8-second pause after five details; these are self-imposed starting values, not an official safe-rate guarantee. Stop and preserve state for expired login, platform limits, user takeover, or explicit pause. Never bypass security verification.
6. Verify account continuity, the unfiltered order list, and the actual first page before claiming coverage. A filtered empty view, unknown account marker, or jump to an old page cannot prove completion. Keep source-list coverage, payment coverage, status coverage, and remaining quality issues separate. Use `complete_with_pending` when list traversal is complete but fields remain unverified.

## Preserve identity and payment semantics

Read [money and stable identity](references/money-and-identity.md).

- Preserve immutable raw sources. Merge by stable order/item identity; incremental collection must not erase labels, notes, or verified amounts. Export followed by DOM enrichment must keep the original item ID and avoid double counting. Ambiguous matches stay pending.
- Use explicitly verified item-level paid prices. Never substitute list prices or split a parent order's cash payment across multiple items. Shopping-credit top-ups are excluded; goods bought with credit retain their item-level value even if order cash paid is zero.
- Retain closed orders for audit while excluding them from spending and labeling. Orders with unknown status also stay outside spending, candidates, character matching, and monthly facts until verified. Unknown amounts/quantities remain unknown, never zero or an assumed one.
- Keep paid price, verified refund, and net payment separate. Never subtract a refund twice. Preserve non-divisible line totals instead of inventing rounded unit amounts.
- Retain status, quantity, specifications, payment, refunds, credit information, image provenance, source, and capture time. Classification uncertainty must not cause guessed prices.

## Deliver six modules

The local service loads `assets/app/`. New accounts start empty, with no author's or other users' real orders, pictures, labels, or reports.

1. **消费总览:** verified item payments and honest coverage; missing data is not zero.
2. **消费档案馆:** daily monetary amounts, with readable yearly charts.
3. **买垃圾了吗:** default to labeled low-usage items, ordered by paid price descending; total only the labeled low-usage portion. Preserve the title “钱花在了刀背上” and gray subtitle “买回来根本没怎么用的东西”. Accounts without labels start with pending items.
4. **幸福月报:** automatically write about small monthly joys using concrete purchased objects, warmth, and light humor, rather than a statistical report.
5. **消费人格:** always choose one of six familiar fictional characters for entertainment, including sparse records. Use short, funny, shareable copy and supported behavioral evidence. Do not hard-code the author's 郭芙蓉 result for everyone or fabricate purchases to justify a match.
6. **明年建议:** automatically schedule 1–2 actionable tasks for every month of the following year. Preserve user edits and completion state. Emphasize the tasks, with optional editing and alternatives secondary.

## Generate articles with the current assistant

After the first useful batch or completed collection, run `python3 -B <skill>/scripts/content.py facts --project <project> --output <project>/reports/facts.json`. Read only this small fact pack. Following [content guidance](references/content.md), write multiple months at once into `<project>/reports/drafts.json`, then run `python3 -B <skill>/scripts/content.py apply --project <project> --input <project>/reports/drafts.json`.

Use the current assistant, with no additional model key or user action. Do not call a model per product. Every article must reference current-month fact IDs and the current data version. Do not invent use, motives, relationships, or health conclusions. Exclude sensitive facts from shareable articles. Regenerate against the current version after collection changes; the user's own edited monthly note always takes priority.

## Save, restore, and report accurately

- Automatically save labels, price corrections, articles, and tasks to the isolated project's SQLite store. Display “已保存” only after HTTP acknowledgment. Merge conflicts safely; preserve unsaved content on failure and provide retry/export. Browser localStorage is not the sole source of truth.
- Keep raw sources separate from personal edits, and provide reversible archives/restoration. Read [storage and migration](references/storage-and-migration.md) for imports, history recovery, and project/account switching.
- Report the actual covered date range, pending counts, workbench URL, and project location. Do not claim all history is collected before proving the start-date boundary or true list end.
- Default to local-only use. Publishing a skill does not authorize uploading anyone's orders, publicly sharing reports, or changing any hosted journal. Cloud deployment requires a separate explicit request and suitable access controls.
- This is a trial. Synthetic tests are not real-Taobao validation. On first live use, the assistant checks a small batch against visible pages before continuing automatically. Do not promise a fixed duration; estimate from actual export availability, order volume, and detail gaps.
