# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this project, please do **not** open a
public issue. Report it privately via the GitHub Security Advisory
("Report a vulnerability" button on the repository page) or by opening a
private security disclosure.

We will acknowledge the report within 3 business days and work with you on a
fix and coordinated disclosure. Please include:

- Affected version(s)
- A minimal reproduction (config, steps, observed behavior)
- Impact assessment if known

## Scope

This plugin runs as a DeepSeek Harness bundle and holds Feishu app
credentials (`~/.dsh-feishucard/feishu.config.json`). Never commit
`appSecret` / tokens to git, and do not share the config file.

Since 0.7.22 the long-connection helper no longer receives `appSecret` as a
command-line argument (visible to every account on a shared host via `ps aux`);
the plugin writes a per-bot `helper-cred-*.json` (mode `0600`) next to the config
and passes only its path. The file is deleted when the bot is removed from the
config, but not when a helper restarts — it carries the same secret that
`feishu.config.json` already stores in that directory, so protect the whole
directory the same way.

Since 0.8.0 the plugin also reads a **bot roster** (`bot_roster.json` in the same
config directory, mode `0600`, never inside the workspace) that maps Feishu
`union_id` / per-app `open_id` to names. Treat it as personal data: it is a
directory of human identities. If it is missing or an id is unknown the plugin
logs `[fs] roster miss` instead of guessing — an unresolved id is never a name.

**Annotation is not authorization.** Who sent a message, who was mentioned, and
who tapped a card are surfaced for readability only. Permission decisions are
made exclusively by the identity guard (`resolveActor(open_id)`, opt-in, off by
default) against the identity map; a recognizable name, a roster hit, or a known
`operator` on a card callback grants nothing.

Two side effects worth knowing before enabling things:

- An outbound `@` really notifies a human and really wakes another bot's agent
  turn. Unresolvable or ambiguous names are therefore left as plain text with an
  explicit `（未能 @ 出：X）` note rather than guessed at.
- `groupRelay` is `self_only` by default, i.e. group messages that do not mention
  this bot are ignored. Opening it (per bot or per chat) is how two agents end up
  talking to each other; measured blow-up without limits was 3666 events in 5
  minutes between two bots in one group, so the three-tier budget (per-pair 3/90s
  → 10-minute freeze, per-chat 8/60s → drop, any human message re-arms) is
  always on for relayed traffic. Human messages never consume budget.

Ids in logs and cards are truncated (10/12/8 chars by context); full ids stay in
the session context the agent reads, not on the card face.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.8.x   | ✅ Yes             |
| 0.7.x   | ✅ Yes             |
| 0.3.x   | ✅ Yes             |
| 0.2.x   | ✅ Yes             |
| 0.1.x   | ❌ No              |
| < 0.1   | ❌ No              |
