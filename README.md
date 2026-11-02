# youyou-gouwu-journal

A Codex skill for turning several years of personal Taobao purchase history into a private, six-module spending journal. The assistant runs setup, collection, resume, normalization, and article generation; the normal user flow is signing into Taobao and labeling item usage.

[中文说明](README.zh-CN.md) · [Iteration history](ITERATIONS.md)

The skill and repository are now named `youyou-gouwu-journal`. Collection currently supports Taobao. Existing journal projects and resume markers retain their original storage paths for compatibility.

## Install and use

Send this instruction to Codex:

> Install the skill from https://github.com/ruoruochen/youyou-gouwu-journal and analyze my last 10 years of Taobao purchases. Collect and resume automatically, preserving raw records and existing labels.

After installation, ask:

> 使用 $youyou-gouwu-journal 分析我的3年淘宝消费记录。

The usual Codex installation location is `~/.codex/skills/youyou-gouwu-journal`. No additional model API key is required. The assistant handles commands and imports; users are not expected to run a terminal or prepare spreadsheets.

## What it produces

- A spending overview based on verified item payments and explicit coverage.
- A purchase archive showing money spent per day.
- A low-usage view whose total counts only items the user has labeled low usage.
- Warm monthly happiness articles grounded in actual purchased objects.
- A short, shareable match to one of six familiar fictional characters.
- One or two automatically scheduled tasks for every month of the next year.

Collection runs serially from newest to oldest, without order/product searches. A supported official export is used only when actually visible; otherwise scripts collect the list and supplement necessary details. Missing fields are queued and checkpoints support resume. Login, security challenges, and platform restrictions remain under the user's control.

## Payment and privacy

Item-level actual paid prices are distinct from list prices, order cash settlement, and verified net payments. Shopping-credit top-ups are excluded; items bought with credit retain their item-level value even when order cash paid is zero. Closed or status-unknown orders do not enter spending statistics. Unknown fields are never filled with guessed values.

Private projects, original captures, images, labels, and reports stay outside the skill directory. The workbench uses a loopback-only Python service and SQLite, with automatic save acknowledgment and recovery history. The published package contains reusable code/templates only. It does not upload purchase history, deploy a public journal, or change an existing website.

## Trial status and requirements

Version: **0.1.0-trial**. Requires Codex with local execution, Python 3, Node.js 18+, and a connected Ego browser environment. Setup the assistant can perform is handled automatically; browser authorization or security challenges may still require the user.

The implementation passed 46 synthetic script tests, browser UI checks, and independent cold-start audits. These validate the implementation, not every future Taobao page. **Real-account collection and elapsed time have not been validated for this trial.** The assistant must check a small live batch on first use. Taobao interface changes, unavailable exports, login expiry, or platform restrictions can require adaptation or pause collection.

This is a local skill, not a standalone hosted website. A static upload alone cannot run its Python API, database, or browser collector.
