# Security policy

## Supported version

Security fixes are made on the latest version published from the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Email the
maintainer at the address on the repository's GitHub profile with a concise
description, reproduction steps, affected version, and any suggested mitigation.

We will acknowledge reports within seven days and coordinate a fix and
disclosure timeline with the reporter when the report is confirmed.

## Security model

OmachatGPT is an Omarchy shell plugin, so its QML runs within the user's
long-lived `omarchy-shell` process. The bundled Node bridge starts a locally
installed Codex CLI with read-only sandboxing, approvals disabled, MCP servers
cleared, and local-action features disabled. The plugin should not be treated as
a security boundary or as a substitute for reviewing the source before enabling
it.
