# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
