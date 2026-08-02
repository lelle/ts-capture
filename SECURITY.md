# Security Policy

ts-capture is a hobby/research project under best-effort maintenance.
Security reports are taken seriously, but response times are not
guaranteed.

## Supported versions

Only the latest `0.x` release line receives fixes. The API may change
between minor versions while the project is pre-1.0.

| Version      | Supported |
| ------------ | --------- |
| latest `0.x` | ✅        |
| older        | ❌        |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/lelle/ts-capture/security/advisories/new).
If that is unavailable, email **sverre.olnes@gmail.com** with `[ts-capture
security]` in the subject.

Please include:

- affected package(s) and version(s),
- a minimal reproduction (ideally an `Input` → `Current` code example),
- impact and any known mitigation.

You'll get an acknowledgement when the report is read. Fixes ship as a
patch release with a GitHub Security Advisory once available.

## Scope notes

ts-capture **instruments and rewrites source files** and **executes your
code** to observe runtime values. Treat it as a development-time tool:
run it only on code and inputs you trust, and never on untrusted input in
production. Reports about this documented behaviour are not vulnerabilities;
reports about unexpected escalation beyond it are.
