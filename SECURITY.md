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
credentials (`~/.cc-connect/feishu.config.json`). Never commit `appSecret` /
tokens to git, and do not share the config file.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | ✅ Yes             |
| < 0.1   | ❌ No              |
