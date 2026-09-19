# Third-party notices

OmachatGPT is MIT-licensed. It uses the following external software and
services at runtime:

| Component | Role | License or terms |
| --- | --- | --- |
| [Omarchy](https://omarchy.org/) and its Quattro shell | Hosts and displays the panel | Provided by Omarchy; see its distribution terms. |
| [Node.js](https://nodejs.org/) | Runs the bundled bridge | MIT license. |
| [Codex CLI and app-server](https://developers.openai.com/docs/app-server) | Authenticated conversation and web-search service | Subject to OpenAI terms and account eligibility. |

Development-only dependencies are recorded and pinned in `package.json` and
`pnpm-lock.yaml`. No third-party JavaScript packages are loaded at runtime.
