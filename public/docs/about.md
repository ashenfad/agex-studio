# About

agex.studio is a free, open-source, browser-based AI agent
workspace. It runs as a static page. There's no company behind
it, no servers, no account system, no subscription.

For the broader framing of what that means in practice, see
[Getting started](#getting-started).

## Built with

The studio is a thin shell over a stack of separately-developed
libraries:

- [agex-ts](https://github.com/ashenfad/agex-ts) — TypeScript agent
  orchestration. The studio's primary kernel.
- [agex](https://github.com/ashenfad/agex) — Python agent
  orchestration. Powers the experimental Python kernel.
- [Pyodide](https://pyodide.org) — Python in WebAssembly. The
  Python kernel runs inside it.
- [calgebra](https://github.com/ashenfad/calgebra) — Calendar
  interval algebra, used by the Google Calendar integration.
- [kvgit](https://github.com/ashenfad/kvgit) — Versioned key-value
  store backing sessions and the agent's filesystem.
- [Svelte 5](https://svelte.dev) — UI framework.

LLM access is your choice: [OpenRouter](https://openrouter.ai),
[Anthropic](https://anthropic.com), [OpenAI](https://openai.com),
or any OpenAI-compatible endpoint.

## Source

Studio: [github.com/ashenfad/agex-studio](https://github.com/ashenfad/agex-studio).

## Contact

Questions, feedback, gallery submissions: open an issue on
[GitHub](https://github.com/ashenfad/agex-studio/issues).
