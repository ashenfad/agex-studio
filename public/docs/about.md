# About

agex.studio is a free, open-source AI agent workspace that runs in
your browser. It's a static page: no company behind it, no servers of
its own, no accounts, no subscription. The model is one you choose,
on your own key.

For what that means day to day, see [Getting started](#getting-started).

## Built with

- [agex-ts](https://github.com/ashenfad/agex-ts): the agent and
  everything under it, in four packages. `agex-ts` is the agent's
  loop (its turns, folding long conversations, delegation, tasks);
  `@agex-ts/world` is the workspace (sessions, files, the shell, the
  TypeScript kernel the agent's code runs in); `@agex-ts/kvgit` is the
  versioned store underneath (every change a commit, and sync); and
  `@agex-ts/termish` is the shell.
- The [AI SDK](https://ai-sdk.dev)'s providers, for talking to
  OpenRouter or an endpoint of your own.
- [Svelte 5](https://svelte.dev) for the interface.
- [esbuild](https://esbuild.github.io) (in WebAssembly) for apps
  written in JSX, [Plotly](https://plotly.com/javascript/) for
  charts, and [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs.

## Source

The studio: [github.com/ashenfad/agex-studio](https://github.com/ashenfad/agex-studio).

## Contact

Questions and feedback: open an issue on
[GitHub](https://github.com/ashenfad/agex-studio/issues).
