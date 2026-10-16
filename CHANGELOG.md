# Changelog

All notable changes to OmachatGPT are documented here.

## 0.3.0 - 2026-10-15

- Add native Omarchy status-bar icon (`BarWidget.qml`) with a pull-down menu for
  Open Chat / Hide Chat, New Chat, and Settings….
- Add unified model picker grouping OpenAI (`codex login`) and OpenRouter
  open-weight models, with seamless mid-conversation model switching and
  standalone OpenRouter support.
- Add in-panel Settings (`Ctrl+,`) for recording a custom global shortcut and
  configuring the OpenRouter API key and open-source model list (`slug` or
  `slug | Display Name`).
- Add on-demand OpenRouter web search (`plugins: [{ id: "web" }]`) with inline
  Markdown source citations.
- Add automatic conversation naming from the first prompt, code-block math
  protection, strict subprocess environment allowlisting, and hardened tool
  blocking.

## 0.2.2 - 2026-09-19

- Rename the visible panel, preview, documentation, and Codex conversation
  label from Quick Chat to OmachatGPT.

## 0.2.1 - 2026-09-19

- Fix hosted CI setup ordering so pnpm is available before dependency-cache
  configuration.

## 0.2.0 - 2026-09-19

- Initial public release of the OmachatGPT panel for Omarchy.
- Resumable text chat backed by the locally authenticated Codex CLI.
- Live web search, streaming Markdown display, clickable sources, and safe
  clipboard copying.
- Read-only local sandbox, approvals disabled, no MCP servers, and blocked
  local-action capabilities.
