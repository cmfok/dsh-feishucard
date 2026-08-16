# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Approval cards: dsh `approval/request` for plugin-owned Feishu sessions is
  answered via an interactive Feishu card with `✅ 允许一次` / `❌ 拒绝` buttons
  (`card.action.trigger` long-connection events); 3-minute timeout auto-rejects
  (rule shown on the card),
  agent abort settles as cancelled; card shows the final outcome after the user
  clicks. Fixes sessions hanging forever when audit sentinels ask without a
  GUI answerer (2026-08-15).
- User questions: `ask_user_question` tool calls from Feishu-owned agents are
  intercepted on the `tools/execute` waterfall (stock DSH, no source patches)
  and answered in the chat — the next plain message is the answer, returned as
  a normal tool success. Also covers plan-review questions (2026-08-16).
- `/stop` command: cancels the CURRENT live agent (resolved via `agents.list()`
  instead of a possibly stale cached handle), processed immediately (bypasses
  the serial message chain so it can interrupt a running turn) (2026-08-16).
- `/plan` routes through the harness commands registry (plan-mode registers it
  there) with an injected-planMode fallback; `ctx.get('planMode')` misses the
  service across bundle scopes (2026-08-16).
- Card clicks (`card.action.trigger`) bypass the serial chain so approvals
  settle instantly; the approval card is recalled after the decision instead
  of lingering at the bottom of the chat (2026-08-16).
- Card fold redesign: history folds into a top `📎 更早过程` panel, the newest
  10 elements stay visible — content scrolls forward as it grows (2026-08-15).
- helper: registers `card.action.trigger`, `LoggerLevel.info`, and a raw-event
  debug hook; the host logs raw events for observability (2026-08-16).

## [0.1.0] - 2026-08-15

### Added

- Official Feishu (Lark) SDK long connection (no public URL required): helper
  subprocess per bot, JSON-line protocol on stdout, crash auto-restart.
- Per-chat dedicated agent sessions (never shared with GUI sessions), session
  persistence across restarts, `/new /switch /list /help` commands.
- Streaming reply card: one card per turn, PATCH-updated live — inline
  agent notes + collapsible tool-call panels with status symbols, sealed with
  the final reply; rate-limit coalescing, exponential backoff, circuit
  breaker, and a plain-text fallback.
- Typing reaction (OnIt) added on arrival and removed after reply delivery.
- `feishu_send` model tool for proactive messages.
- Hot-reloadable config at `~/.dsh-feishucard/feishu.config.json`, with a
  one-time automatic migration from a legacy `~/.cc-connect` config if
  present.
- Smoke test suite (mocked DSH context + mocked Feishu API) covering the full
  turn pipeline.

### Fixed

- Fast turns (< 300ms) could lose narration/tool panels because the event
  watcher never polled before seal; a catch-up scan now runs at seal time.
- Helper subprocess could be spawned repeatedly while booting (status not yet
  `running`); a per-bot spawn cooldown prevents duplicate processes.
- Resuming a session DSH still marks live (e.g. after a hard kill) is rejected
  by the platform (`cannot prepare session ... while it is live`); the plugin
  now automatically creates a fallback session so messages always get a reply.
- Live sessions (restored by DSH on boot, or held by the GUI) are now reused
  directly from `agents.list()` instead of failing to resume, so conversation
  context survives restarts.

### Changed

- Config/state moved from the legacy `~/.cc-connect/` location to the
  project's own `~/.dsh-feishucard/` directory; a one-time automatic
  migration preserves an existing legacy config.
- README rewritten in naturally mixed Chinese/English; added CI workflow
  (syntax check + secret scan + smoke test).
