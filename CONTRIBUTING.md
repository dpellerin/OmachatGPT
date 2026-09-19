# Contributing

Thanks for improving OmachatGPT.

## Development setup

Use Node.js 20 or newer and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs the unit tests, TypeScript check, build, and a clean staged
Omarchy plugin validation. Keep `src/` and the checked-in `dist/` output in
sync. The plugin installer does not install dependencies or build TypeScript.

## Changes

- Keep the panel keyboard-first and preserve its deliberately narrow chat scope.
- Do not add command execution, file access, browser control, MCP, plugin,
  image, or agent capabilities without a security review and explicit user-facing
  documentation.
- Add or update tests for behavior changes.
- Run `pnpm verify` before opening a pull request.
- Do not run `pnpm smoke` in automated checks: it makes a real authenticated
  model request and consumes the contributor's account allowance.

## Reporting issues

For bugs and feature requests, include the Omarchy version, Codex CLI version,
and reproducible steps. See [SECURITY.md](SECURITY.md) for private vulnerability
reports.
